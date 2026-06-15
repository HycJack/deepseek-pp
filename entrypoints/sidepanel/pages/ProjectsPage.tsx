import { useEffect, useMemo, useRef, useState } from 'react';
import type { ProjectContext, ProjectContextState, ProjectFile } from '../../../core/types';
import PageIntro from '../components/PageIntro';
import { requestGitHubProjectImportPermission } from '../github-permission';
import { useI18n } from '../i18n';
import { getRuntimeErrorMessage, unwrapRuntimeResponse } from '../runtime-response';

type ImportState = 'idle' | 'running' | 'error' | 'done';

export default function ProjectsPage() {
  const { t } = useI18n();
  const [state, setState] = useState<ProjectContextState | null>(null);
  const [name, setName] = useState('');
  const [instructions, setInstructions] = useState('');
  const [githubUrl, setGithubUrl] = useState('');
  const [githubToken, setGithubToken] = useState('');
  const [manualPath, setManualPath] = useState('notes.md');
  const [manualContent, setManualContent] = useState('');
  const [importState, setImportState] = useState<ImportState>('idle');
  const [message, setMessage] = useState('');
  const [statusMessage, setStatusMessage] = useState('');
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    void load().catch(showProjectError);
    const handler = (msg: { type?: string; state?: ProjectContextState }) => {
      if (msg.type === 'PROJECT_CONTEXT_UPDATED') {
        if (isProjectContextState(msg.state)) {
          setState(msg.state);
          setStatusMessage('');
        }
      }
    };
    chrome.runtime.onMessage.addListener(handler);
    return () => chrome.runtime.onMessage.removeListener(handler);
  }, []);

  const activeProject = useMemo(
    () => state?.projects.find((project) => project.id === state.activeProjectId) ?? null,
    [state],
  );
  const activeFiles = useMemo(
    () => state?.files.filter((file) => file.projectId === activeProject?.id) ?? [],
    [activeProject?.id, state],
  );

  async function load() {
    const response = await chrome.runtime.sendMessage({ type: 'GET_PROJECT_CONTEXT_STATE' });
    const next = unwrapProjectResponse<ProjectContextState>(
      response,
      t('sidepanel.projectsPage.backendUnavailable'),
    );
    if (!isProjectContextState(next)) {
      throw new Error(t('sidepanel.projectsPage.backendUnavailable'));
    }
    setState(next);
    return next;
  }

  async function createProject() {
    if (!name.trim()) return;
    try {
      setStatusMessage('');
      const response = await chrome.runtime.sendMessage({
        type: 'CREATE_PROJECT_CONTEXT',
        payload: { name, instructions },
      });
      const project = unwrapProjectResponse<ProjectContext>(
        response,
        t('sidepanel.projectsPage.backendUnavailable'),
      );
      if (!isProjectContext(project)) {
        throw new Error(t('sidepanel.projectsPage.backendUnavailable'));
      }
      setName('');
      setInstructions('');
      await load();
    } catch (error) {
      showProjectError(error);
    }
  }

  async function setActive(projectId: string | null) {
    try {
      unwrapProjectResponse(await chrome.runtime.sendMessage({
        type: 'SET_ACTIVE_PROJECT_CONTEXT',
        payload: { projectId },
      }), t('sidepanel.projectsPage.backendUnavailable'));
      await load();
    } catch (error) {
      showProjectError(error);
    }
  }

  async function deleteProject(project: ProjectContext) {
    if (!confirm(t('sidepanel.projectsPage.deleteConfirm', { name: project.name }))) return;
    try {
      unwrapProjectResponse(await chrome.runtime.sendMessage({
        type: 'DELETE_PROJECT_CONTEXT',
        payload: { projectId: project.id },
      }), t('sidepanel.projectsPage.backendUnavailable'));
      await load();
    } catch (error) {
      showProjectError(error);
    }
  }

  async function addManualFile() {
    if (!activeProject || !manualPath.trim() || !manualContent.trim()) return;
    try {
      setMessage('');
      unwrapProjectResponse(await chrome.runtime.sendMessage({
        type: 'ADD_PROJECT_FILES',
        payload: {
          projectId: activeProject.id,
          files: [{ path: manualPath, content: manualContent, sourceKind: 'manual' }],
        },
      }), t('sidepanel.projectsPage.backendUnavailable'));
      setManualContent('');
      await load();
    } catch (error) {
      setMessage(t('sidepanel.projectsPage.operationFailed', { error: getRuntimeErrorMessage(error) }));
    }
  }

  async function importGithub() {
    if (!activeProject || !githubUrl.trim()) return;
    setImportState('running');
    setMessage('');
    try {
      const granted = await requestGitHubProjectImportPermission();
      if (!granted) {
        setImportState('error');
        setMessage(t('sidepanel.projectsPage.permissionError'));
        return;
      }
      const result = unwrapProjectResponse<{
        files?: ProjectFile[];
        warnings?: string[];
      }>(await chrome.runtime.sendMessage({
        type: 'IMPORT_GITHUB_PROJECT_CONTEXT',
        payload: {
          projectId: activeProject.id,
          url: githubUrl,
          token: githubToken.trim() || undefined,
        },
      }), t('sidepanel.projectsPage.backendUnavailable'));
      const warnings = result.warnings?.length ?? 0;
      setImportState('done');
      setMessage(warnings > 0
        ? t('sidepanel.projectsPage.importCompleteWithWarnings', { count: result.files?.length ?? 0, warnings })
        : t('sidepanel.projectsPage.importComplete', { count: result.files?.length ?? 0 }));
      await load();
    } catch (error) {
      setImportState('error');
      setMessage(error instanceof Error ? error.message : String(error));
    }
  }

  async function importLocalFiles(files: FileList | null) {
    if (!activeProject || !files?.length) return;
    const inputs = [];
    for (const file of Array.from(files)) {
      if (file.size > 512 * 1024) continue;
      const path = (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
      inputs.push({ path, content: await file.text(), sourceKind: 'local_folder' });
    }
    if (inputs.length === 0) return;
    try {
      setMessage('');
      unwrapProjectResponse(await chrome.runtime.sendMessage({
        type: 'ADD_PROJECT_FILES',
        payload: { projectId: activeProject.id, files: inputs },
      }), t('sidepanel.projectsPage.backendUnavailable'));
      if (fileInputRef.current) fileInputRef.current.value = '';
      await load();
    } catch (error) {
      setMessage(t('sidepanel.projectsPage.operationFailed', { error: getRuntimeErrorMessage(error) }));
    }
  }

  function showProjectError(error: unknown) {
    setStatusMessage(t('sidepanel.projectsPage.operationFailed', { error: getRuntimeErrorMessage(error) }));
  }

  return (
    <div className="p-4 space-y-4">
      <PageIntro
        title={t('sidepanel.projectsPage.title')}
        description={t('sidepanel.projectsPage.description')}
        meta={t('sidepanel.projectsPage.summary', {
          projects: state?.projects.length ?? 0,
          files: state?.files.length ?? 0,
        })}
      />

      <section className="ds-surface-panel rounded-xl p-4 space-y-3">
        <div className="text-xs font-semibold" style={{ color: 'var(--ds-text)' }}>
          {t('sidepanel.projectsPage.createTitle')}
        </div>
        <input
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder={t('sidepanel.projectsPage.namePlaceholder')}
          className="w-full px-3 py-2 text-xs rounded-lg border outline-none"
          style={inputStyle}
        />
        <textarea
          value={instructions}
          onChange={(event) => setInstructions(event.target.value)}
          placeholder={t('sidepanel.projectsPage.instructionsPlaceholder')}
          className="w-full px-3 py-2 text-xs rounded-lg border outline-none min-h-[72px]"
          style={inputStyle}
        />
        <button
          type="button"
          onClick={createProject}
          disabled={!name.trim()}
          className="ds-btn-primary px-3 py-2 text-xs rounded-lg disabled:opacity-40"
        >
          {t('sidepanel.projectsPage.createProject')}
        </button>
        {statusMessage && (
          <div className="text-[11px] rounded-lg px-2 py-1.5" style={{ color: 'var(--ds-text-secondary)', background: 'var(--ds-surface)' }}>
            {statusMessage}
          </div>
        )}
      </section>

      <section className="space-y-2">
        {(state?.projects ?? []).map((project) => (
          <div key={project.id} className="ds-surface-panel rounded-xl p-3 flex items-start gap-3">
            <button
              type="button"
              onClick={() => setActive(project.id)}
              className="mt-1 w-4 h-4 rounded-full border"
              style={{
                background: project.id === state?.activeProjectId ? 'var(--ds-blue)' : 'transparent',
                borderColor: 'var(--ds-border)',
              }}
              aria-label={t('sidepanel.projectsPage.activateProject', { name: project.name })}
            />
            <div className="flex-1 min-w-0">
              <div className="text-xs font-medium truncate" style={{ color: 'var(--ds-text)' }}>{project.name}</div>
              <div className="text-[11px]" style={{ color: 'var(--ds-text-tertiary)' }}>
                {t('sidepanel.projectsPage.fileCount', {
                  count: (state?.files ?? []).filter((file) => file.projectId === project.id).length,
                })}
              </div>
            </div>
            <button type="button" onClick={() => deleteProject(project)} className="ds-btn-secondary px-2 py-1 text-[11px] rounded-md">
              {t('sidepanel.projectsPage.deleteProject')}
            </button>
          </div>
        ))}
        {(state?.projects.length ?? 0) === 0 && (
          <div className="ds-empty-state">
            <div className="ds-empty-state-icon">
              <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V7z" />
              </svg>
            </div>
            <div className="ds-empty-state-title">{t('sidepanel.projectsPage.empty')}</div>
            <div className="ds-empty-state-description">{t('sidepanel.projectsPage.emptyHelp')}</div>
          </div>
        )}
      </section>

      {activeProject && (
        <section className="ds-surface-panel rounded-xl p-4 space-y-3">
          <div className="text-xs font-semibold" style={{ color: 'var(--ds-text)' }}>
            {t('sidepanel.projectsPage.activeProject', { name: activeProject.name })}
          </div>
          <div className="grid grid-cols-1 gap-2">
            <input
              value={githubUrl}
              onChange={(event) => setGithubUrl(event.target.value)}
              placeholder={t('sidepanel.projectsPage.githubPlaceholder')}
              className="px-3 py-2 text-xs rounded-lg border outline-none"
              style={inputStyle}
            />
            <input
              value={githubToken}
              onChange={(event) => setGithubToken(event.target.value)}
              placeholder={t('sidepanel.projectsPage.githubTokenPlaceholder')}
              type="password"
              autoComplete="off"
              className="px-3 py-2 text-xs rounded-lg border outline-none"
              style={inputStyle}
            />
            <div className="text-[10px] leading-relaxed" style={{ color: 'var(--ds-text-tertiary)' }}>
              {t('sidepanel.projectsPage.githubTokenHelp')}
            </div>
            <button
              type="button"
              onClick={importGithub}
              disabled={importState === 'running' || !githubUrl.trim()}
              className="ds-btn-secondary px-3 py-2 text-xs rounded-lg disabled:opacity-40"
            >
              {importState === 'running' ? t('sidepanel.projectsPage.importingGithub') : t('sidepanel.projectsPage.importGithub')}
            </button>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              // Chromium supports folder import through this non-standard attribute.
              {...{ webkitdirectory: '' }}
              onChange={(event) => void importLocalFiles(event.target.files)}
              className="text-xs"
              style={{ color: 'var(--ds-text-secondary)' }}
            />
          </div>
          {message && (
            <div className="text-[11px] rounded-lg px-2 py-1.5" style={{ color: 'var(--ds-text-secondary)', background: 'var(--ds-surface)' }}>
              {message}
            </div>
          )}
          <div className="space-y-2">
            <input
              value={manualPath}
              onChange={(event) => setManualPath(event.target.value)}
              className="w-full px-3 py-2 text-xs rounded-lg border outline-none"
              style={inputStyle}
              placeholder={t('sidepanel.projectsPage.manualPathPlaceholder')}
            />
            <textarea
              value={manualContent}
              onChange={(event) => setManualContent(event.target.value)}
              className="w-full px-3 py-2 text-xs rounded-lg border outline-none min-h-[90px]"
              style={inputStyle}
              placeholder={t('sidepanel.projectsPage.manualContentPlaceholder')}
            />
            <button
              type="button"
              onClick={addManualFile}
              disabled={!manualPath.trim() || !manualContent.trim()}
              className="ds-btn-secondary px-3 py-2 text-xs rounded-lg disabled:opacity-40"
            >
              {t('sidepanel.projectsPage.addManualFile')}
            </button>
          </div>
          <div className="space-y-1 max-h-52 overflow-y-auto">
            {activeFiles.map((file) => (
              <label key={file.id} className="flex items-center gap-2 text-[11px]" style={{ color: 'var(--ds-text-secondary)' }}>
                <input
                  type="checkbox"
                  checked={(state?.activeFileIds.length ?? 0) === 0 || state?.activeFileIds.includes(file.id)}
                  onChange={(event) => {
                    const current = new Set(state?.activeFileIds.length ? state.activeFileIds : activeFiles.map((item) => item.id));
                    if (event.target.checked) current.add(file.id);
                    else current.delete(file.id);
                    void chrome.runtime.sendMessage({
                      type: 'SET_ACTIVE_PROJECT_FILES',
                      payload: { projectId: activeProject.id, fileIds: [...current] },
                    })
                      .then((response) => unwrapProjectResponse(response, t('sidepanel.projectsPage.backendUnavailable')))
                      .then(load)
                      .catch((error) => setMessage(t('sidepanel.projectsPage.operationFailed', { error: getRuntimeErrorMessage(error) })));
                  }}
                />
                <span className="truncate">{file.path}</span>
                <span className="shrink-0">{file.sizeBytes} B</span>
              </label>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

const inputStyle = {
  background: 'var(--ds-bg)',
  borderColor: 'var(--ds-border)',
  color: 'var(--ds-text)',
};

function unwrapProjectResponse<T = unknown>(response: unknown, missingMessage: string): T {
  return unwrapRuntimeResponse<T>(response, missingMessage);
}

function isProjectContextState(value: unknown): value is ProjectContextState {
  if (!value || typeof value !== 'object') return false;
  const state = value as ProjectContextState;
  return Array.isArray(state.projects) &&
    Array.isArray(state.files) &&
    (state.activeProjectId === null || typeof state.activeProjectId === 'string') &&
    Array.isArray(state.activeFileIds);
}

function isProjectContext(value: unknown): value is ProjectContext {
  if (!value || typeof value !== 'object') return false;
  const project = value as ProjectContext;
  return typeof project.id === 'string' &&
    typeof project.name === 'string' &&
    typeof project.instructions === 'string';
}
