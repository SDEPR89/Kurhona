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
import { useToast } from '../hooks/useToast';
import { useMediaQuery } from '../hooks/useMediaQuery';
import { useDragAndDrop } from '../hooks/useDragAndDrop';
import { useNotifications } from '../hooks/useNotifications';
import { QUADRANTS } from '../types';
import type { Quadrant as QuadrantId, Task, Subject, Status } from '../types';
import { ThemeToggle } from './ThemeToggle';
import { Quadrant } from './Quadrant';
import { TaskCard } from './TaskCard';
import { TaskModal } from './TaskModal';
import { SettingsModal } from './SettingsModal';
import { Calendar } from './Calendar';
import { DoneList } from './DoneList';
import { StatusDetail } from './StatusDetail';
import { Visualizer3D } from './Visualizer3D';
import './Dashboard.css';

type View = 'dashboard' | 'matrix' | 'calendar' | 'completed';

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
  const toast = useToast();
  const {
    tasks,
    liveTasks,
    setLiveTasks,
    snapshotLiveTasks,
    restoreLiveTasks,
    clearLiveTasksSnapshot,
    loading,
    error,
    createTask,
    updateTask,
    setDueDate,
    completeTask,
    uncompleteTask,
    deleteTask,
    reorder,
    reorderBusy,
    isBusy: isTaskBusy,
  } = useTasks(userId, { showError: toast.showError });
  const { subjects, addSubject, deleteSubject, isBusy: isSubjectBusy } = useSubjects(userId, {
    showError: toast.showError,
  });
  const confirm = useConfirm();

  const [view, setView] = useState<View>('dashboard');
  const [editing, setEditing] = useState<
    | { kind: 'create'; quadrant: QuadrantId; dueDate?: string }
    | { kind: 'edit'; task: Task }
    | null
  >(null);
  // Mobile-only: tapping a task's status dot sets this so the
  // full-page StatusDetail picker can render. Desktop users edit
  // status via the TaskModal, so this stays null on desktop.
  const [statusDetailTask, setStatusDetailTask] = useState<Task | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  // Live viewport query — mirrors the CSS breakpoints in Dashboard.css.
  // ≤720px  → mobile  (bottom tab bar, no sidebar)
  // 721–1024px → tablet (collapsed icon sidebar)
  // ≥1025px → desktop (full sidebar)
  const isMobile = useMediaQuery('(max-width: 720px)');
  const isTablet = useMediaQuery('(min-width: 721px) and (max-width: 1024px)');

  // Deadline notification system — schedules browser push notifications
  // for tasks with upcoming due dates. Only active when the user opts in
  // via the bell toggle in the sidebar.
  const notif = useNotifications(tasks, userId);


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
    surface: toast.showError,
  });

  // Active tab: open tasks grouped by quadrant; Done tab: completed
  // tasks sorted by completed_at desc.
  const grouped = useMemo(() => {
    const active = tasks.filter((t) => !t.completed_at);
    const done = tasks.filter((t) => !!t.completed_at);
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
    return { groups, done: doneSorted };
  }, [tasks]);

  const activeCount =
    grouped.groups.do_first.length +
    grouped.groups.schedule.length +
    grouped.groups.delegate.length +
    grouped.groups.eliminate.length;
  const doneCount = grouped.done.length;

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

  function handleAdd(quadrant: QuadrantId) {
    setEditing({ kind: 'create', quadrant });
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

  // Calendar's `tasks` prop is the un-filtered active list.
  const activeTasksForCalendar: Task[] = grouped.groups.do_first
    .concat(grouped.groups.schedule, grouped.groups.delegate, grouped.groups.eliminate);

  return (
    <div
      className={
        isMobile === true
          ? 'dashboard-mobile-container'
          : isTablet === true
            ? 'dashboard-desktop-container dashboard-tablet'
            : 'dashboard-desktop-container'
      }
    >
      {isMobile !== true && (
        <DashboardSidebar
          view={view}
          onChangeView={setView}
          activeCount={activeCount}
          doneCount={doneCount}
          isAnonymous={isAnonymous}
          userDisplayUsername={userDisplayUsername}
          userUsername={userUsername}
          userEmail={userEmail}
          onOpenSettings={() => setSettingsOpen(true)}
          onSignOut={handleSignOut}
          isCollapsed={isTablet === true}
          notifSupported={notif.isSupported}
          notifPermission={notif.permission}
          notifEnabled={notif.isEnabled}
          onNotifToggle={notif.toggle}
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

        {error && (
          <p className="dashboard-error" role="alert">
            {error}
          </p>
        )}

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
          notifSupported={notif.isSupported}
          notifPermission={notif.permission}
          notifEnabled={notif.isEnabled}
          onNotifToggle={notif.toggle}
        />
      )}


      {editing?.kind === 'create' && (
        <TaskModal
          mode="create"
          initial={{
            quadrant: editing.quadrant,
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
  view: View;
  onChangeView: (v: View) => void;
  activeCount: number;
  doneCount: number;
  isAnonymous: boolean;
  userDisplayUsername: string | null;
  userUsername: string | null;
  userEmail: string | null;
  onOpenSettings: () => void;
  onSignOut: () => void;
  isCollapsed?: boolean;
  // Notification bell
  notifSupported: boolean;
  notifPermission: NotificationPermission | 'unsupported';
  notifEnabled: boolean;
  onNotifToggle: () => Promise<void>;
}

function DashboardSidebar({
  view,
  onChangeView,
  activeCount,
  doneCount,
  isAnonymous,
  userDisplayUsername,
  userUsername,
  userEmail,
  onOpenSettings,
  onSignOut,
  isCollapsed = false,
  notifSupported,
  notifPermission,
  notifEnabled,
  onNotifToggle,
}: DashboardSidebarProps) {
  const { theme, toggle: toggleTheme } = useTheme();
  return (
    <aside className={`dashboard-sidebar${isCollapsed ? ' dashboard-sidebar--collapsed' : ''}`}>
      <div className="brand">
        <img className="brand-mark" src="/logo.png" alt="Kurhona" />
        {!isCollapsed && <span className="brand-name">Kurhona</span>}
      </div>

      <nav className="sidebar-nav" aria-label="Main Navigation">
        <button
          type="button"
          className={`sidebar-link${view === 'dashboard' ? ' is-active' : ''}`}
          onClick={() => onChangeView('dashboard')}
          title="Dashboard"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <circle cx="12" cy="12" r="10" />
            <circle cx="12" cy="12" r="6" />
            <circle cx="12" cy="12" r="2" />
          </svg>
          {!isCollapsed && <span>Dashboard</span>}
        </button>

        <button
          type="button"
          className={`sidebar-link${view === 'matrix' ? ' is-active' : ''}`}
          onClick={() => onChangeView('matrix')}
          title="Tasks"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <rect x="3" y="3" width="7" height="7" rx="1" />
            <rect x="14" y="3" width="7" height="7" rx="1" />
            <rect x="3" y="14" width="7" height="7" rx="1" />
            <rect x="14" y="14" width="7" height="7" rx="1" />
          </svg>
          {!isCollapsed && <span>Tasks</span>}
          {!isCollapsed && <span className="sidebar-count">{activeCount}</span>}
          {isCollapsed && activeCount > 0 && <span className="sidebar-count sidebar-count--dot">{activeCount}</span>}
        </button>

        <button
          type="button"
          className={`sidebar-link${view === 'calendar' ? ' is-active' : ''}`}
          onClick={() => onChangeView('calendar')}
          title="Calendar"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <rect x="3" y="4" width="18" height="18" rx="2" />
            <line x1="16" y1="2" x2="16" y2="6" />
            <line x1="8" y1="2" x2="8" y2="6" />
            <line x1="3" y1="10" x2="21" y2="10" />
          </svg>
          {!isCollapsed && <span>Calendar</span>}
        </button>

        <button
          type="button"
          className={`sidebar-link${view === 'completed' ? ' is-active' : ''}`}
          onClick={() => onChangeView('completed')}
          title="Completed"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
            <polyline points="22 4 12 14.01 9 11.01" />
          </svg>
          {!isCollapsed && <span>Completed</span>}
          {!isCollapsed && <span className="sidebar-count">{doneCount}</span>}
          {isCollapsed && doneCount > 0 && <span className="sidebar-count sidebar-count--dot">{doneCount}</span>}
        </button>
      </nav>

      <div className="sidebar-footer">
        {!isCollapsed && (
          <div className="sidebar-user-info">
            <span className="username">
              {isAnonymous ? 'Guest' : userDisplayUsername ?? userUsername ?? userEmail}
            </span>
            <ThemeToggle theme={theme} onToggle={toggleTheme} />
          </div>
        )}

        <div className="sidebar-actions">
          {isCollapsed && <ThemeToggle theme={theme} onToggle={toggleTheme} />}
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

          {/* Notification bell — shown when notifications are supported */}
          {notifSupported && (
            <button
              type="button"
              className={`sidebar-action-btn notification-bell${notifEnabled ? ' is-enabled' : ''}${notifPermission === 'denied' ? ' is-blocked' : ''}`}
              onClick={onNotifToggle}
              title={
                notifPermission === 'denied'
                  ? 'Notifications blocked — enable in browser settings'
                  : notifEnabled
                  ? 'Notifications on — click to turn off'
                  : 'Turn on deadline reminders'
              }
              aria-label="Toggle deadline notifications"
              aria-pressed={notifEnabled}
            >
              {notifEnabled ? (
                /* Bell with clapper (filled) — notifications ON */
                <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" strokeWidth="0" aria-hidden="true">
                  <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
                  <path d="M13.73 21a2 2 0 0 1-3.46 0" />
                </svg>
              ) : (
                /* Bell outline — notifications OFF */
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
                  <path d="M13.73 21a2 2 0 0 1-3.46 0" />
                </svg>
              )}
            </button>
          )}

          {!isCollapsed && (
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
          )}
        </div>
      </div>
    </aside>
  );
}


interface DashboardMobileTabbarProps {
  view: View;
  onChangeView: (v: View) => void;
  onOpenSettings: () => void;
  notifSupported: boolean;
  notifPermission: NotificationPermission | 'unsupported';
  notifEnabled: boolean;
  onNotifToggle: () => Promise<void>;
}

function DashboardMobileTabbar({ view, onChangeView, onOpenSettings, notifSupported, notifPermission, notifEnabled, onNotifToggle }: DashboardMobileTabbarProps) {
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

      {/* Bell tab — only when browser supports notifications */}
      {notifSupported && (
        <button
          type="button"
          className={`mobile-tab mobile-tab--bell notification-bell${notifEnabled ? ' is-enabled' : ''}${notifPermission === 'denied' ? ' is-blocked' : ''}`}
          onClick={onNotifToggle}
          aria-label={notifEnabled ? 'Notifications on — tap to turn off' : 'Turn on deadline reminders'}
          aria-pressed={notifEnabled}
        >
          {notifEnabled ? (
            <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" strokeWidth="0" aria-hidden="true">
              <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
              <path d="M13.73 21a2 2 0 0 1-3.46 0" />
            </svg>
          ) : (
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
              <path d="M13.73 21a2 2 0 0 1-3.46 0" />
            </svg>
          )}
          <span>{notifEnabled ? 'Alerts On' : 'Alerts'}</span>
        </button>
      )}
    </nav>
  );
}

interface DashboardViewProps {
  view: View;
  dnd: ReturnType<typeof useDragAndDrop>;
  grouped: { groups: Record<QuadrantId, Task[]>; done: Task[] };
  liveGroups: Record<QuadrantId, Task[]>;
  activeTasksForCalendar: Task[];
  loading: boolean;
  subjects: Subject[];
  onAdd: (q: QuadrantId) => void;
  onAddOnDate: (iso: string) => void;
  onEdit: (t: Task) => void;
  onToggleComplete: (t: Task) => void;
  onDelete: (t: Task) => void;
  isTaskBusy?: (id: string) => boolean;
  reorderBusy: boolean;
  renderOverlay: () => React.ReactNode;
  onOpenStatusDetail?: (t: Task) => void;
  activeEditingTaskId: string | null;
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
  } = props;

  // View branch router
  if (view === 'dashboard') {
    const activeCount =
      grouped.groups.do_first.length +
      grouped.groups.schedule.length +
      grouped.groups.delegate.length +
      grouped.groups.eliminate.length;
    const doneCount = grouped.done.length;
    const totalCount = activeCount + doneCount;
    const completionPercentage = totalCount > 0 ? doneCount / totalCount : 0;

    return (
      <div className="dashboard-view dashboard-pane dashboard-pane--3d" key="3d">
        <Visualizer3D
          tasks={activeTasksForCalendar}
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
