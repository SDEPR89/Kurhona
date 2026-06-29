import { useEffect, useMemo, useState } from 'react';
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
import { QUADRANTS } from '../types';
import type { Quadrant as QuadrantId, Task, Subject } from '../types';
import { ThemeToggle } from './ThemeToggle';
import { Quadrant } from './Quadrant';
import { TaskCard } from './TaskCard';
import { TaskModal } from './TaskModal';
import { SettingsModal } from './SettingsModal';
import { Calendar } from './Calendar';
import { DoneList } from './DoneList';
import './Dashboard.css';

type View = 'active' | 'done';
type MobileTab = 'matrix' | 'calendar';

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

  const [view, setView] = useState<View>('active');
  const [editing, setEditing] = useState<
    | { kind: 'create'; quadrant: QuadrantId; dueDate?: string }
    | { kind: 'edit'; task: Task }
    | null
  >(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [mobileTab, setMobileTab] = useState<MobileTab>('matrix');
  // Live viewport query — mirrors the CSS breakpoint at
  // Dashboard.css (`@media (max-width: 720px)`).
  const isMobile = useMediaQuery('(max-width: 720px)');
  // When the viewport grows past the breakpoint, reset the mobile
  // tab back to `matrix` so a rotating phone / resized browser
  // doesn't strand the user on a Calendar view they can't reach
  // from desktop.
  useEffect(() => {
    if (isMobile === false) setMobileTab('matrix');
  }, [isMobile]);

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

  async function handleCreateSubject(name: string, color: string) {
    return await addSubject({ name, color });
  }

  async function handleSave(data: {
    title: string;
    description: string | null;
    subject_id: string | null;
    due_date: string | null;
    quadrant: QuadrantId;
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
        isMobile === true && mobileTab === 'calendar'
          ? 'dashboard is-mobile-calendar'
          : 'dashboard'
      }
    >
      <DashboardHeader
        isAnonymous={isAnonymous}
        userDisplayUsername={userDisplayUsername}
        userUsername={userUsername}
        userEmail={userEmail}
        onOpenSettings={() => setSettingsOpen(true)}
      />

      <DashboardToolbar
        view={view}
        activeCount={activeCount}
        doneCount={doneCount}
        onChangeView={setView}
      />

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
        mobileTab={mobileTab}
        isMobile={isMobile}
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
      />

      <DashboardMobileTabbar
        mobileTab={mobileTab}
        onChangeTab={setMobileTab}
        onOpenSettings={() => setSettingsOpen(true)}
      />

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
            quadrant: editing.task.quadrant,
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
          onSignOut={handleSignOut}
          onAccountDeleted={onAccountDeleted}
          onAccountUpgraded={onAccountUpgraded}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sub-components — inline because they're tightly coupled to
// Dashboard's state and aren't reused elsewhere. Each owns one
// visual concern: the header, the Active/Done toolbar, the
// view-switching branch (matrix / calendar / done), and the mobile
// tab bar. JSX factored out by concern, not by reuse.
// ---------------------------------------------------------------------------

interface DashboardHeaderProps {
  isAnonymous: boolean;
  userDisplayUsername: string | null;
  userUsername: string | null;
  userEmail: string | null;
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
        <div className="brand-mark">A</div>
        <span>Acme</span>
      </div>
      <div className="dashboard-user">
        <span className="dashboard-display-name">
          {isAnonymous
            ? 'Guest'
            : userDisplayUsername ?? userUsername ?? userEmail}
        </span>
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

interface DashboardToolbarProps {
  view: View;
  activeCount: number;
  doneCount: number;
  onChangeView: (v: View) => void;
}

function DashboardToolbar({ view, activeCount, doneCount, onChangeView }: DashboardToolbarProps) {
  return (
    <div className="dashboard-toolbar">
      <h1>Eisenhower Matrix</h1>
      <div className="view-toggle" role="tablist" aria-label="View">
        <button
          type="button"
          role="tab"
          aria-selected={view === 'active'}
          className={`view-tab${view === 'active' ? ' is-active' : ''}`}
          onClick={() => onChangeView('active')}
        >
          Active <span className="view-count">{activeCount}</span>
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={view === 'done'}
          className={`view-tab${view === 'done' ? ' is-active' : ''}`}
          onClick={() => onChangeView('done')}
        >
          Done <span className="view-count">{doneCount}</span>
        </button>
      </div>
    </div>
  );
}

interface DashboardMobileTabbarProps {
  mobileTab: MobileTab;
  onChangeTab: (t: MobileTab) => void;
  onOpenSettings: () => void;
}

function DashboardMobileTabbar({ mobileTab, onChangeTab, onOpenSettings }: DashboardMobileTabbarProps) {
  return (
    <nav className="mobile-tabbar" aria-label="Dashboard sections">
      <button
        type="button"
        className={`mobile-tab${mobileTab === 'matrix' ? ' is-active' : ''}`}
        onClick={() => onChangeTab('matrix')}
        aria-current={mobileTab === 'matrix' ? 'page' : undefined}
      >
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <rect x="3" y="3" width="7" height="7" rx="1.2" />
          <rect x="14" y="3" width="7" height="7" rx="1.2" />
          <rect x="3" y="14" width="7" height="7" rx="1.2" />
          <rect x="14" y="14" width="7" height="7" rx="1.2" />
        </svg>
        <span>Matrix</span>
      </button>
      <button
        type="button"
        className={`mobile-tab${mobileTab === 'calendar' ? ' is-active' : ''}`}
        onClick={() => onChangeTab('calendar')}
        aria-current={mobileTab === 'calendar' ? 'page' : undefined}
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
  mobileTab: MobileTab;
  isMobile: boolean | null;
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
}

function DashboardView(props: DashboardViewProps) {
  const {
    mobileTab,
    isMobile,
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
  } = props;

  // Three branches: mobile calendar, active (matrix + DnD), done.
  // The mobile-calendar path skips <DndContext> so calendar drags
  // don't compete with matrix drops; the active path installs a
  // single context for both matrix and (desktop) calendar mounts.
  if (isMobile === true && mobileTab === 'calendar') {
    return (
      <div className="dashboard-view dashboard-pane dashboard-pane--calendar" key="cal">
        <Calendar tasks={activeTasksForCalendar} onTaskClick={onEdit} onAddOnDate={onAddOnDate} />
      </div>
    );
  }

  if (view === 'active') {
    return (
      <div className="dashboard-view dashboard-pane dashboard-pane--matrix" key="active">
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
              />
            ))}
          </div>
          {isMobile !== true && (
            <Calendar tasks={activeTasksForCalendar} onTaskClick={onEdit} onAddOnDate={onAddOnDate} />
          )}
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
    <div className="dashboard-view" key="done">
      <DoneList
        tasks={grouped.done}
        subjects={subjects}
        onToggleComplete={onToggleComplete}
        onTaskClick={onEdit}
        onDelete={onDelete}
        loading={loading}
        isTaskBusy={isTaskBusy}
      />
    </div>
  );
}
