import { useCallback, useMemo, useState } from 'react';
import {
  DndContext,
  DragOverlay,
} from '@dnd-kit/core';
import { snapCenterToCursor } from '@dnd-kit/modifiers';
import { useTasks } from '../hooks/useTasks';
import { useSubjects } from '../hooks/useSubjects';
import { useTheme } from '../hooks/useTheme';
import { useConfirm } from '../hooks/useConfirm';
import { useMediaQuery } from '../hooks/useMediaQuery';
import { useDragAndDrop } from '../hooks/useDragAndDrop';
import { usePushSubscription } from '../hooks/usePushSubscription';
import { QUADRANTS } from '../types';
import type { Quadrant as QuadrantId, Task, Subject, Status, TaskType } from '../types';
import { ThemeToggle } from './ThemeToggle';
import { Quadrant } from './Quadrant';
import { TaskCard } from './TaskCard';
import { TaskModal } from './TaskModal';
import { SettingsModal } from './SettingsModal';
import { Calendar } from './Calendar';
import { DoneList } from './DoneList';
import { TestsView } from './TestsView';
import { StatusDetail } from './StatusDetail';
import { Visualizer3D } from './Visualizer3D';
import { InstallPrompt } from './InstallPrompt';
import './Dashboard.css';

type View = 'dashboard' | 'matrix' | 'calendar' | 'completed' | 'tests';

interface Props {
  userId: string;
  userEmail: string | null;
  userUsername: string | null;
  userDisplayUsername: string | null;
  // True when the user signed in anonymously. The header shows
  // "Guest" instead of trying to fall back to a missing username
  // or email, and the Settings modal surfaces an upgrade path.
  isAnonymous: boolean;
  onSignOut: () => void;
  onUsernameUpdated: (newUsername: string) => void;
  onAccountDeleted: () => void;
  // Fired after the user attaches an email + password in the
  // Settings → Upgrade section. App.tsx flips the local user out
  // of "anonymous" mode.
  onAccountUpgraded: (newEmail: string) => void;
}

export function Dashboard({
  userId,
  userEmail,
  userUsername,
  userDisplayUsername,
  isAnonymous,
  onSignOut,
  onUsernameUpdated,
  onAccountDeleted,
  onAccountUpgraded,
}: Props) {
  const confirm = useConfirm();

  // Dashboard-scoped error banner. Replaces the deleted useToast
  // surface: hooks that need to surface a failure (useTasks,
  // useSubjects, useDragAndDrop) call this through `showError`.
  // The banner renders near the top of the dashboard shell so
  // the user sees it regardless of which view is active.
  const [dashboardError, setDashboardError] = useState<string | null>(null);
  const showError = useCallback((message: string) => {
    setDashboardError(message);
  }, []);

  const {
    tasks,
    liveTasks,
    setLiveTasks,
    snapshotLiveTasks,
    restoreLiveTasks,
    clearLiveTasksSnapshot,
    loading,
    createTask,
    updateTask,
    setDueDate,
    completeTask,
    uncompleteTask,
    deleteTask,
    reorder,
    reorderBusy,
    isBusy: isTaskBusy,
  } = useTasks(userId, { showError });
  const { subjects, addSubject, deleteSubject, isBusy: isSubjectBusy } = useSubjects(userId, {
    showError,
  });

  const [view, setView] = useState<View>('dashboard');
  const [editing, setEditing] = useState<
    | { kind: 'create'; quadrant: QuadrantId; dueDate?: string; taskType?: TaskType }
    | { kind: 'edit'; task: Task }
    | null
  >(null);
  // Mobile-only: tapping a task's status dot sets this so the
  // full-page StatusDetail picker can render. Desktop users edit
  // status via the TaskModal, so this stays null on desktop.
  const [statusDetailTask, setStatusDetailTask] = useState<Task | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  // Live viewport query — mirrors the CSS breakpoint at
  // Dashboard.css (`@media (max-width: 720px)`).
  const isMobile = useMediaQuery('(max-width: 720px)');

  // Drag-and-drop logic (collisions, refs, handlers, live grouping)
  // lives in useDragAndDrop. Dashboard owns the JSX shell.
  const dnd = useDragAndDrop({
    liveTasks,
    setLiveTasks,
    snapshotLiveTasks,
    restoreLiveTasks,
    clearLiveTasksSnapshot,
    reorder,
    setDueDate,
    surface: showError,
  });

  // Active tab: open tasks grouped by quadrant; Done tab: completed
  // tasks sorted by completed_at desc.
  const grouped = useMemo(() => {
    const homeworkTasks = tasks.filter((t) => (t.task_type ?? 'homework') === 'homework');
    const active = homeworkTasks.filter((t) => !t.completed_at);
    const done = homeworkTasks.filter((t) => !!t.completed_at);
    const groups: Record<QuadrantId, Task[]> = {
      do_first: [],
      schedule: [],
      delegate: [],
      eliminate: [],
    };
    for (const t of active) groups[t.quadrant].push(t);
    const doneSorted = [...done].sort((a, b) => {
      const aT = a.completed_at ?? '';
      const bT = b.completed_at ?? '';
      return bT.localeCompare(aT);
    });

    // Test/exam tasks. Strict equality is intentional — null rows
    // (pre-migration) are treated as 'homework' by the DB default,
    // never as 'test', so no ?? fallback needed here.
    const testTasks = tasks.filter((t) => t.task_type === 'test');
    const activeTests = testTasks.filter((t) => !t.completed_at).sort((a, b) => {
      // Sort by due_date asc (upcoming first), nulls last
      if (!a.due_date && !b.due_date) return 0;
      if (!a.due_date) return 1;
      if (!b.due_date) return -1;
      return a.due_date.localeCompare(b.due_date);
    });
    const doneTests = testTasks.filter((t) => !!t.completed_at).sort((a, b) => {
      const aT = a.completed_at ?? '';
      const bT = b.completed_at ?? '';
      return bT.localeCompare(aT);
    });

    return { groups, done: doneSorted, activeTests, doneTests };
  }, [tasks]);

  const activeCount =
    grouped.groups.do_first.length +
    grouped.groups.schedule.length +
    grouped.groups.delegate.length +
    grouped.groups.eliminate.length;
  const doneCount = grouped.done.length;
  const testCount = grouped.activeTests.length;

  async function handleSignOut() {
    if (signingOut) return;
    setSigningOut(true);
    try {
      setEditing(null);
      setSettingsOpen(false);
      await onSignOut();
    } finally {
      setSigningOut(false);
    }
  }

  function handleAdd(quadrant: QuadrantId, taskType?: TaskType) {
    setEditing({ kind: 'create', quadrant, taskType });
  }

  function handleAddOnDate(isoDate: string) {
    setEditing({ kind: 'create', quadrant: 'do_first', dueDate: isoDate });
  }

  function handleEdit(task: Task) {
    setEditing({ kind: 'edit', task });
  }

  function handleToggleComplete(task: Task) {
    if (task.completed_at) uncompleteTask(task.id);
    else completeTask(task.id);
  }

  // Status change from the mobile StatusDetail picker. The picker
  // closes itself; this just persists the new value. The hook's
  // surface() call (via showError) handles the failure case via
  // toast — the user has already moved on by the time the request
  // round-trips.
  async function handleStatusChange(task: Task, status: Status) {
    await updateTask(task.id, { status });
  }

  // Stable callback for the StatusDetail's onClose. Without this the
  // picker re-attaches its keydown listener on every parent render
  // because the inline arrow would have a new identity each time.
  const closeStatusDetail = useCallback(() => setStatusDetailTask(null), []);

  async function handleCreateSubject(name: string, color: string) {
    return await addSubject({ name, color });
  }

  async function handleSave(data: {
    title: string;
    description: string | null;
    subject_id: string | null;
    due_date: string | null;
    due_time: string | null;
    quadrant: QuadrantId;
    status: Status;
    task_type: TaskType;
  }): Promise<boolean> {
    if (!editing) return false;
    const row =
      editing.kind === 'create'
        ? await createTask(data)
        : await updateTask(editing.task.id, data);
    if (!row) return false;
    setEditing(null);
    return true;
  }

  async function handleDelete() {
    if (editing?.kind !== 'edit') return;
    const ok = await confirm({
      title: 'Delete task?',
      message: 'This cannot be undone.',
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!ok) return;
    void deleteTask(editing.task.id).catch(() => {});
    setEditing(null);
  }

  async function handleDeleteTaskFromCard(task: Task) {
    const ok = await confirm({
      title: `Delete "${task.title}"?`,
      message: 'This cannot be undone.',
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!ok) return;
    void deleteTask(task.id).catch(() => {});
  }

  // Look up the dragged task in the live mirror so the overlay
  // reflects the in-flight quadrant if the user has already
  // re-bucketed via onDragOver. Falls back to the canonical
  // quadrant groups if the task disappeared from the mirror (e.g.
  // completed_at was set during the drag).
  const renderOverlay = (): React.ReactNode => {
    if (!dnd.activeDragId) return null;
    const liveFound = liveTasks.find((t) => t.id === dnd.activeDragId);
    const canonicalList = grouped.groups.do_first
      .concat(grouped.groups.schedule, grouped.groups.delegate, grouped.groups.eliminate);
    const task = liveFound ?? canonicalList.find((t) => t.id === dnd.activeDragId);
    if (!task) return null;
    return (
      <TaskCard
        task={task}
        subject={subjects.find((s) => s.id === task.subject_id)}
        onToggleComplete={() => {}}
        onClick={() => {}}
        onDelete={() => {}}
        isBusy={false}
      />
    );
  };

  // Calendar gets homework + test tasks so test due dates show on the grid.
  const activeTasksForCalendar: Task[] = grouped.groups.do_first
    .concat(grouped.groups.schedule, grouped.groups.delegate, grouped.groups.eliminate, grouped.activeTests);

  return (
    <div
      className={
        isMobile === true
          ? 'dashboard-mobile-container'
          : 'dashboard-desktop-container'
      }
    >
      {isMobile !== true && (
        <DashboardSidebar
          userId={userId}
          view={view}
          onChangeView={setView}
          activeCount={activeCount}
          doneCount={doneCount}
          testCount={testCount}
          isAnonymous={isAnonymous}
          userDisplayUsername={userDisplayUsername}
          userUsername={userUsername}
          userEmail={userEmail}
          onOpenSettings={() => setSettingsOpen(true)}
          onSignOut={handleSignOut}
          onReminderError={showError}
        />
      )}

      <div className="dashboard-main-content">
        {isMobile === true && (
          <DashboardHeader
            isAnonymous={isAnonymous}
            userDisplayUsername={userDisplayUsername}
            userUsername={userUsername}
            userEmail={userEmail}
            onOpenSettings={() => setSettingsOpen(true)}
            isMobile={isMobile}
          />
        )}

        {dashboardError && (
          <p
            className="dashboard-error"
            role="alert"
            onClick={() => setDashboardError(null)}
          >
            {dashboardError}
          </p>
        )}

        {/* iOS-only banner: tells the user to install the PWA
            before reminders can fire. Self-mounts based on UA, so
            it returns null on every other platform. */}
        <InstallPrompt />

        {isAnonymous && (
          <div className="dashboard-guest-banner" role="status">
            <span>
              You're browsing as a guest. Your tasks save to this browser only.{' '}
              <button
                type="button"
                className="inline-link"
                onClick={() => setSettingsOpen(true)}
              >
                Add an email and password
              </button>{' '}
              to keep them across devices.
            </span>
          </div>
        )}

        <DashboardView
          activeEditingTaskId={editing?.kind === 'edit' ? editing.task.id : null}
          view={view}
          dnd={dnd}
          grouped={grouped}
          liveGroups={dnd.liveGroups}
          activeTasksForCalendar={activeTasksForCalendar}
          loading={loading}
          subjects={subjects}
          onAdd={handleAdd}
          onAddOnDate={handleAddOnDate}
          onEdit={handleEdit}
          onToggleComplete={handleToggleComplete}
          onDelete={handleDeleteTaskFromCard}
          isTaskBusy={isTaskBusy}
          reorderBusy={reorderBusy}
          renderOverlay={renderOverlay}
          activeTests={grouped.activeTests}
          doneTests={grouped.doneTests}
          // Mobile only: tap a task's status dot to open the full-page
          // picker. On desktop we pass undefined so the card renders a
          // non-interactive <span> for the dot.
          onOpenStatusDetail={isMobile === true ? setStatusDetailTask : undefined}
        />
      </div>

      {isMobile === true && (
        <DashboardMobileTabbar
          view={view}
          onChangeView={setView}
          onOpenSettings={() => setSettingsOpen(true)}
        />
      )}

      {editing?.kind === 'create' && (
        <TaskModal
          mode="create"
          initial={{
            quadrant: editing.quadrant,
            task_type: editing.taskType ?? 'homework',
            ...(editing.dueDate ? { due_date: editing.dueDate } : {}),
          }}
          subjects={subjects}
          onCreateSubject={handleCreateSubject}
          onDeleteSubject={deleteSubject}
          onClose={() => setEditing(null)}
          onSave={handleSave}
          isSubjectBusy={isSubjectBusy}
        />
      )}

      {editing?.kind === 'edit' && (
        <TaskModal
          mode="edit"
          initial={{
            id: editing.task.id,
            title: editing.task.title,
            description: editing.task.description,
            subject_id: editing.task.subject_id,
            due_date: editing.task.due_date,
            due_time: editing.task.due_time,
            quadrant: editing.task.quadrant,
            status: editing.task.status,
            task_type: editing.task.task_type,
          }}
          subjects={subjects}
          onCreateSubject={handleCreateSubject}
          onDeleteSubject={deleteSubject}
          onClose={() => setEditing(null)}
          onSave={handleSave}
          onDelete={handleDelete}
          isSubjectBusy={isSubjectBusy}
        />
      )}

      {settingsOpen && (
        <SettingsModal
          userId={userId}
          userEmail={userEmail}
          currentUsername={userUsername}
          currentDisplayUsername={userDisplayUsername}
          isAnonymous={isAnonymous}
          onClose={() => setSettingsOpen(false)}
          onUsernameUpdated={onUsernameUpdated}
          onAccountDeleted={onAccountDeleted}
          onAccountUpgraded={onAccountUpgraded}
        />
      )}

      {/*
        StatusDetail — mobile-only full-page picker. Mounted on
        mobile because the card's status dot is only tappable there
        (on desktop, `onOpenStatusDetail` is undefined). Look up the
        latest task from the canonical list so the picker sees a
        fresh `status` value (the one captured in `statusDetailTask`
        could be stale by the time the user opens it).
       */}
      {statusDetailTask && (
        <StatusDetail
          task={tasks.find((t) => t.id === statusDetailTask.id) ?? statusDetailTask}
          subject={subjects.find((s) => s.id === statusDetailTask.subject_id)}
          onChange={(next) => handleStatusChange(statusDetailTask, next)}
          onClose={closeStatusDetail}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sub-components — inline because they're tightly coupled to
// Dashboard's state and aren't reused elsewhere. Each owns one
// visual concern: the header, the Sidebar, the view-switching branch,
// and the mobile tab bar. JSX factored out by concern, not by reuse.
// ---------------------------------------------------------------------------

interface DashboardHeaderProps {
  isAnonymous: boolean;
  userDisplayUsername: string | null;
  userUsername: string | null;
  userEmail: string | null;
  isMobile: boolean | null;
  onOpenSettings: () => void;
}

function DashboardHeader({
  isAnonymous,
  userDisplayUsername,
  userUsername,
  userEmail,
  onOpenSettings,
}: DashboardHeaderProps) {
  const { theme, toggle: toggleTheme } = useTheme();
  return (
    <header className="dashboard-header">
      <div className="brand">
        <img className="brand-mark" src="/logo.png" alt="Kurhona" />
        <span className="brand-name">Kurhona</span>
        <span className="dashboard-display-name">
          {isAnonymous
            ? 'Guest'
            : userDisplayUsername ?? userUsername ?? userEmail}
        </span>
      </div>
      <div className="dashboard-user">
        <ThemeToggle theme={theme} onToggle={toggleTheme} />
        <button
          type="button"
          className="header-icon-btn header-settings-btn"
          onClick={onOpenSettings}
          aria-label="Open settings"
          title="Settings"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
          </svg>
        </button>
      </div>
    </header>
  );
}

interface DashboardSidebarProps {
  userId: string;
  view: View;
  onChangeView: (v: View) => void;
  activeCount: number;
  doneCount: number;
  testCount: number;
  isAnonymous: boolean;
  userDisplayUsername: string | null;
  userUsername: string | null;
  userEmail: string | null;
  onOpenSettings: () => void;
  onSignOut: () => void;
  onReminderError: (message: string) => void;
}

function DashboardSidebar({
  userId,
  view,
  onChangeView,
  activeCount,
  doneCount,
  testCount,
  isAnonymous,
  userDisplayUsername,
  userUsername,
  userEmail,
  onOpenSettings,
  onSignOut,
  onReminderError,
}: DashboardSidebarProps) {
  const { theme, toggle: toggleTheme } = useTheme();
  return (
    <aside className="dashboard-sidebar">
      <div className="brand">
        <img className="brand-mark" src="/logo.png" alt="Kurhona" />
        <span className="brand-name">Kurhona</span>
      </div>

      <nav className="sidebar-nav" aria-label="Main Navigation">
        <button
          type="button"
          className={`sidebar-link${view === 'dashboard' ? ' is-active' : ''}`}
          onClick={() => onChangeView('dashboard')}
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <circle cx="12" cy="12" r="10" />
            <circle cx="12" cy="12" r="6" />
            <circle cx="12" cy="12" r="2" />
          </svg>
          <span>Dashboard</span>
        </button>

        <button
          type="button"
          className={`sidebar-link${view === 'matrix' ? ' is-active' : ''}`}
          onClick={() => onChangeView('matrix')}
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <rect x="3" y="3" width="7" height="7" rx="1" />
            <rect x="14" y="3" width="7" height="7" rx="1" />
            <rect x="3" y="14" width="7" height="7" rx="1" />
            <rect x="14" y="14" width="7" height="7" rx="1" />
          </svg>
          <span>Tasks</span>
          <span className="sidebar-count">{activeCount}</span>
        </button>

        <button
          type="button"
          className={`sidebar-link${view === 'tests' ? ' is-active' : ''}`}
          onClick={() => onChangeView('tests')}
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M9 11l3 3L22 4" />
            <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
          </svg>
          <span>Tests</span>
          {testCount > 0 && <span className="sidebar-count">{testCount}</span>}
        </button>

        <button
          type="button"
          className={`sidebar-link${view === 'calendar' ? ' is-active' : ''}`}
          onClick={() => onChangeView('calendar')}
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <rect x="3" y="4" width="18" height="18" rx="2" />
            <line x1="16" y1="2" x2="16" y2="6" />
            <line x1="8" y1="2" x2="8" y2="6" />
            <line x1="3" y1="10" x2="21" y2="10" />
          </svg>
          <span>Calendar</span>
        </button>

        <button
          type="button"
          className={`sidebar-link${view === 'completed' ? ' is-active' : ''}`}
          onClick={() => onChangeView('completed')}
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
            <polyline points="22 4 12 14.01 9 11.01" />
          </svg>
          <span>Completed</span>
          <span className="sidebar-count">{doneCount}</span>
        </button>
      </nav>

      <div className="sidebar-footer">
        <div className="sidebar-user-info">
          <span className="username">
            {isAnonymous ? 'Guest' : userDisplayUsername ?? userUsername ?? userEmail}
          </span>
          <ThemeToggle theme={theme} onToggle={toggleTheme} />
        </div>
        
        <div className="sidebar-actions">
          <button
            type="button"
            className="sidebar-action-btn"
            onClick={onOpenSettings}
            title="Settings"
            aria-label="Settings"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </svg>
          </button>

          <ReminderActionButton userId={userId} onError={onReminderError} />
          
          <button
            type="button"
            className="sidebar-action-btn"
            onClick={onSignOut}
            title="Sign Out"
            aria-label="Sign Out"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
              <polyline points="16 17 21 12 16 7" />
              <line x1="21" y1="12" x2="9" y2="12" />
            </svg>
          </button>
        </div>
      </div>
    </aside>
  );
}

interface ReminderActionButtonProps {
  userId: string;
  onError: (message: string) => void;
}

function ReminderActionButton({ userId, onError }: ReminderActionButtonProps) {
  const { state, error, subscribe, unsubscribe } = usePushSubscription(userId);
  const [busy, setBusy] = useState(false);
  const isOn = state === 'subscribed';

  async function handleClick() {
    if (busy) return;
    if (state === 'unsupported') {
      onError("Reminders aren't supported in this browser.");
      return;
    }
    if (state === 'unsupported-mobile') {
      onError('Install Kurhona to your home screen, then open it from the app icon to enable reminders.');
      return;
    }
    if (state === 'denied') {
      onError('Notifications are blocked for Kurhona. Enable them in your browser settings to receive reminders.');
      return;
    }
    setBusy(true);
    try {
      const result = isOn ? await unsubscribe() : await subscribe();
      if (!result.ok) {
        onError(result.error ?? error ?? "Couldn't update reminders. Check notification permission and try again.");
      }
    } finally {
      setBusy(false);
    }
  }

  const label = isOn ? 'Turn off reminders' : 'Turn on reminders';

  return (
    <button
      type="button"
      className={`sidebar-action-btn reminder-action-btn${isOn ? ' is-active' : ''}`}
      onClick={handleClick}
      title={label}
      aria-label={label}
      aria-pressed={isOn}
      disabled={busy}
    >
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M6 8a6 6 0 0 1 12 0c0 7 3 7 3 9H3c0-2 3-2 3-9" />
        <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
      </svg>
    </button>
  );
}

interface DashboardMobileTabbarProps {
  view: View;
  onChangeView: (v: View) => void;
  onOpenSettings: () => void;
}

function DashboardMobileTabbar({ view, onChangeView, onOpenSettings }: DashboardMobileTabbarProps) {
  return (
    <nav className="mobile-tabbar" aria-label="Dashboard sections">
      <button
        type="button"
        className={`mobile-tab${view === 'dashboard' ? ' is-active' : ''}`}
        onClick={() => onChangeView('dashboard')}
      >
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <circle cx="12" cy="12" r="10" />
          <circle cx="12" cy="12" r="6" />
          <circle cx="12" cy="12" r="2" />
        </svg>
        <span>Dashboard</span>
      </button>

      <button
        type="button"
        className={`mobile-tab${view === 'matrix' ? ' is-active' : ''}`}
        onClick={() => onChangeView('matrix')}
      >
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <rect x="3" y="3" width="7" height="7" rx="1.2" />
          <rect x="14" y="3" width="7" height="7" rx="1.2" />
          <rect x="3" y="14" width="7" height="7" rx="1.2" />
          <rect x="14" y="14" width="7" height="7" rx="1.2" />
        </svg>
        <span>Tasks</span>
      </button>

      <button
        type="button"
        className={`mobile-tab${view === 'calendar' ? ' is-active' : ''}`}
        onClick={() => onChangeView('calendar')}
      >
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <rect x="3" y="4" width="18" height="18" rx="2" />
          <line x1="16" y1="2" x2="16" y2="6" />
          <line x1="8" y1="2" x2="8" y2="6" />
          <line x1="3" y1="10" x2="21" y2="10" />
        </svg>
        <span>Calendar</span>
      </button>

      <button
        type="button"
        className={`mobile-tab${view === 'completed' ? ' is-active' : ''}`}
        onClick={() => onChangeView('completed')}
      >
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
          <polyline points="22 4 12 14.01 9 11.01" />
        </svg>
        <span>Completed</span>
      </button>

      <button
        type="button"
        className={`mobile-tab${view === 'tests' ? ' is-active' : ''}`}
        onClick={() => onChangeView('tests')}
      >
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M9 11l3 3L22 4" />
          <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
        </svg>
        <span>Tests</span>
      </button>

      <button
        type="button"
        className="mobile-tab mobile-tab--settings"
        onClick={onOpenSettings}
        aria-label="Open settings"
      >
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
        </svg>
        <span>Settings</span>
      </button>
    </nav>
  );
}

interface DashboardViewProps {
  view: View;
  dnd: ReturnType<typeof useDragAndDrop>;
  grouped: { groups: Record<QuadrantId, Task[]>; done: Task[]; activeTests: Task[]; doneTests: Task[] };
  liveGroups: Record<QuadrantId, Task[]>;
  activeTasksForCalendar: Task[];
  loading: boolean;
  subjects: Subject[];
  onAdd: (q: QuadrantId, taskType?: TaskType) => void;
  onAddOnDate: (iso: string) => void;
  onEdit: (t: Task) => void;
  onToggleComplete: (t: Task) => void;
  onDelete: (t: Task) => void;
  isTaskBusy?: (id: string) => boolean;
  reorderBusy: boolean;
  renderOverlay: () => React.ReactNode;
  onOpenStatusDetail?: (t: Task) => void;
  activeEditingTaskId: string | null;
  activeTests: Task[];
  doneTests: Task[];
}

function DashboardView(props: DashboardViewProps) {
  const {
    view,
    dnd,
    grouped,
    liveGroups,
    activeTasksForCalendar,
    loading,
    subjects,
    onAdd,
    onAddOnDate,
    onEdit,
    onToggleComplete,
    onDelete,
    isTaskBusy,
    reorderBusy,
    renderOverlay,
    onOpenStatusDetail,
    activeEditingTaskId,
    activeTests,
    doneTests,
  } = props;

  // View branch router
  if (view === 'dashboard') {
    const activeCount =
      grouped.groups.do_first.length +
      grouped.groups.schedule.length +
      grouped.groups.delegate.length +
      grouped.groups.eliminate.length;

    // "This week" = Mon 00:00 local time through end of Sunday.
    // Only tasks completed within the current week count toward the
    // percentage so it resets naturally every Monday morning.
    const now = new Date();
    const dayOfWeek = now.getDay(); // 0 = Sun
    const daysSinceMon = (dayOfWeek + 6) % 7;  // Mon=0 … Sun=6
    const weekStart = new Date(now);
    weekStart.setHours(0, 0, 0, 0);
    weekStart.setDate(now.getDate() - daysSinceMon);
    const weekStartMs = weekStart.getTime();

    const isThisWeek = (completedAt: string | null) =>
      !!completedAt && new Date(completedAt).getTime() >= weekStartMs;

    const thisWeekDone = grouped.done.filter(t => isThisWeek(t.completed_at));
    const thisWeekDoneTests = grouped.doneTests.filter(t => isThisWeek(t.completed_at));
    const doneCount = thisWeekDone.length + thisWeekDoneTests.length;
    // Denominator = everything that exists or was completed this week.
    // Old completed tasks (prior weeks) are excluded so they don't
    // drag the percentage down at the start of a new week.
    const totalCount =
      activeCount +
      grouped.activeTests.length +
      thisWeekDone.length +
      thisWeekDoneTests.length;
    const completionPercentage = totalCount > 0 ? doneCount / totalCount : 0;

    return (
      <div className="dashboard-view dashboard-pane dashboard-pane--3d" key="3d">
        <Visualizer3D
          tasks={activeTasksForCalendar.filter(t => t.task_type !== 'test')}
          testTasks={grouped.activeTests}
          subjects={subjects}
          onEdit={onEdit}
          completionPercentage={completionPercentage}
          activeEditingTaskId={activeEditingTaskId}
        />
      </div>
    );
  }

  if (view === 'calendar') {
    return (
      <div className="dashboard-view dashboard-pane dashboard-pane--calendar" key="cal">
        <Calendar tasks={activeTasksForCalendar} onTaskClick={onEdit} onAddOnDate={onAddOnDate} />
      </div>
    );
  }

  if (view === 'matrix') {
    return (
      <div className="dashboard-view dashboard-pane dashboard-pane--matrix" key="matrix">
        <DndContext
          sensors={dnd.sensors}
          collisionDetection={dnd.collisionDetection}
          onDragStart={dnd.handleDragStart}
          onDragOver={dnd.handleDragOver}
          onDragEnd={dnd.handleDragEnd}
          onDragCancel={dnd.handleDragCancel}
        >
          <div className="matrix-grid matrix-grid--enter">
            {QUADRANTS.map((q) => (
              <Quadrant
                key={q.id}
                id={q.id}
                tasks={grouped.groups[q.id]}
                liveTasks={liveGroups[q.id]}
                subjects={subjects}
                onAdd={onAdd}
                onToggleComplete={onToggleComplete}
                onTaskClick={onEdit}
                onDelete={onDelete}
                isTaskBusy={isTaskBusy}
                reorderDisabled={reorderBusy}
                onOpenStatusDetail={onOpenStatusDetail}
              />
            ))}
          </div>
          <DragOverlay
            modifiers={[snapCenterToCursor]}
            zIndex={1000}
            dropAnimation={{ duration: 200, easing: 'cubic-bezier(.2,.8,.2,1)' }}
          >
            <div className="drag-overlay">{renderOverlay()}</div>
          </DragOverlay>
        </DndContext>
      </div>
    );
  }

  if (view === 'tests') {
    return (
      <div className="dashboard-view" key="tests">
        <TestsView
          activeTasks={activeTests}
          doneTasks={doneTests}
          subjects={subjects}
          loading={loading}
          onAdd={() => onAdd('do_first', 'test')}
          onEdit={onEdit}
          onToggleComplete={onToggleComplete}
          onDelete={onDelete}
          isTaskBusy={isTaskBusy}
          onOpenStatusDetail={onOpenStatusDetail}
        />
      </div>
    );
  }

  return (
    <div className="dashboard-view" key="completed">
      <DoneList
        tasks={grouped.done}
        subjects={subjects}
        onToggleComplete={onToggleComplete}
        onTaskClick={onEdit}
        onDelete={onDelete}
        loading={loading}
        isTaskBusy={isTaskBusy}
        onOpenStatusDetail={onOpenStatusDetail}
      />
    </div>
  );
}
