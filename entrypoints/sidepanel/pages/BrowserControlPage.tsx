import { useEffect, useMemo, useState } from 'react';
import type {
  BrowserControlSettings,
  BrowserControlState,
  BrowserControlTarget,
} from '../../../core/browser-control';
import PageIntro from '../components/PageIntro';
import { useI18n } from '../i18n';

type BusyState = 'idle' | 'loading' | 'saving' | 'targeting' | 'detaching';

const DEFAULT_SETTINGS: BrowserControlSettings = {
  enabled: false,
  targetTabId: null,
  includeSnapshotAfterActions: true,
  maxSnapshotNodes: 400,
  maxSnapshotTextBytes: 24_000,
};

export default function BrowserControlPage() {
  const { t } = useI18n();
  const [settings, setSettings] = useState<BrowserControlSettings>(DEFAULT_SETTINGS);
  const [state, setState] = useState<BrowserControlState | null>(null);
  const [busy, setBusy] = useState<BusyState>('loading');
  const [message, setMessage] = useState('');

  const targets = useMemo(
    () => state?.targets ?? [],
    [state?.targets],
  );

  useEffect(() => {
    void load();

    const handler = (msg: { type?: string }) => {
      if (msg.type === 'BROWSER_CONTROL_UPDATED' || msg.type === 'TOOL_DESCRIPTORS_UPDATED') {
        void load();
      }
    };
    chrome.runtime.onMessage.addListener(handler);
    return () => chrome.runtime.onMessage.removeListener(handler);
  }, []);

  const load = async () => {
    setBusy((current) => current === 'idle' ? 'loading' : current);
    try {
      const [nextSettings, nextState] = await Promise.all([
        chrome.runtime.sendMessage({ type: 'GET_BROWSER_CONTROL_SETTINGS' }),
        chrome.runtime.sendMessage({ type: 'GET_BROWSER_CONTROL_STATE' }),
      ]) as [BrowserControlSettings | null, BrowserControlState | null];
      setSettings(nextSettings ?? DEFAULT_SETTINGS);
      setState(nextState);
    } finally {
      setBusy('idle');
    }
  };

  const savePatch = async (patch: Partial<BrowserControlSettings>) => {
    setBusy('saving');
    setMessage('');
    try {
      const next = await chrome.runtime.sendMessage({
        type: 'SAVE_BROWSER_CONTROL_SETTINGS',
        payload: patch,
      }) as BrowserControlSettings;
      setSettings(next ?? settings);
      await load();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy('idle');
    }
  };

  const setEnabled = async (enabled: boolean) => {
    setBusy('saving');
    setMessage('');
    try {
      const next = await chrome.runtime.sendMessage({
        type: 'SET_BROWSER_CONTROL_ENABLED',
        payload: { enabled },
      }) as BrowserControlSettings;
      setSettings(next ?? { ...settings, enabled });
      setMessage(enabled
        ? t('sidepanel.browserControlPage.messages.enabled')
        : t('sidepanel.browserControlPage.messages.disabled'));
      await load();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy('idle');
    }
  };

  const selectTarget = async (target: BrowserControlTarget) => {
    if (!target.controllable) return;
    setBusy('targeting');
    setMessage('');
    try {
      const result = await chrome.runtime.sendMessage({
        type: 'SET_BROWSER_CONTROL_TARGET',
        payload: { tabId: target.id },
      });
      if (result?.ok === false) {
        setMessage(String(result.error ?? t('sidepanel.browserControlPage.messages.targetFailed')));
      } else {
        setMessage(t('sidepanel.browserControlPage.messages.targetSelected', { id: target.id }));
      }
      await load();
    } finally {
      setBusy('idle');
    }
  };

  const detach = async () => {
    setBusy('detaching');
    setMessage('');
    try {
      await chrome.runtime.sendMessage({ type: 'DETACH_BROWSER_CONTROL' });
      setMessage(t('sidepanel.browserControlPage.messages.detached'));
      await load();
    } finally {
      setBusy('idle');
    }
  };

  const supported = state?.supported === true;
  const activeTarget = targets.find((target) => target.id === settings.targetTabId) ?? null;

  return (
    <div className="p-4 space-y-4">
      <PageIntro
        title={t('sidepanel.browserControlPage.title')}
        description={t('sidepanel.browserControlPage.description')}
      />

      <div className="ds-surface-panel rounded-xl p-4 space-y-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="text-xs font-medium" style={{ color: 'var(--ds-text)' }}>
              {t('sidepanel.browserControlPage.enableTitle')}
            </div>
            <div className="text-[11px] mt-1 leading-relaxed" style={{ color: 'var(--ds-text-secondary)' }}>
              {supported
                ? t('sidepanel.browserControlPage.enableDescription')
                : t('sidepanel.browserControlPage.unsupported')}
            </div>
          </div>
          <button
            type="button"
            onClick={() => setEnabled(!settings.enabled)}
            disabled={!supported || busy !== 'idle'}
            className="relative shrink-0 w-10 h-[22px] rounded-full transition-colors duration-200 disabled:opacity-50"
            style={{
              background: settings.enabled && supported ? 'var(--ds-blue)' : 'var(--ds-border)',
            }}
            aria-label={t('sidepanel.browserControlPage.enableTitle')}
          >
            <span
              className="ds-switch-thumb absolute top-[3px] left-[3px] w-4 h-4 rounded-full transition-transform duration-200"
              style={{
                transform: settings.enabled && supported ? 'translateX(18px)' : 'translateX(0)',
              }}
            />
          </button>
        </div>

        <StatusGrid
          attached={state?.attached === true}
          enabled={settings.enabled}
          target={activeTarget}
        />

        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={load}
            disabled={busy !== 'idle'}
            className="ds-btn-secondary px-3 py-1.5 text-[11px] rounded-lg disabled:opacity-50"
          >
            {busy === 'loading' ? t('common.loading') : t('common.refresh')}
          </button>
          <button
            type="button"
            onClick={detach}
            disabled={busy !== 'idle' || !state?.attached}
            className="ds-btn-secondary px-3 py-1.5 text-[11px] rounded-lg disabled:opacity-50"
          >
            {busy === 'detaching' ? t('sidepanel.browserControlPage.detaching') : t('sidepanel.browserControlPage.detach')}
          </button>
        </div>

        {message && (
          <div className="text-[11px] px-2 py-1.5 rounded-lg" style={{
            color: 'var(--ds-text-secondary)',
            background: 'var(--ds-surface)',
          }}>
            {message}
          </div>
        )}
      </div>

      <section className="space-y-2">
        <h2 className="text-[13px] font-medium" style={{ color: 'var(--ds-text)' }}>
          {t('sidepanel.browserControlPage.targetsTitle')}
        </h2>
        <div className="space-y-2">
          {targets.map((target) => (
            <TargetRow
              key={target.id}
              target={target}
              selected={target.id === settings.targetTabId}
              disabled={!settings.enabled || busy !== 'idle'}
              onSelect={() => selectTarget(target)}
            />
          ))}
          {targets.length === 0 && (
            <div className="text-[11px] px-3 py-2 rounded-lg" style={{
              color: 'var(--ds-text-tertiary)',
              background: 'var(--ds-surface)',
            }}>
              {t('sidepanel.browserControlPage.noTargets')}
            </div>
          )}
        </div>
      </section>

      <section className="ds-surface-panel rounded-xl p-4 space-y-3">
        <h2 className="text-[13px] font-medium" style={{ color: 'var(--ds-text)' }}>
          {t('sidepanel.browserControlPage.snapshotTitle')}
        </h2>
        <ToggleRow
          label={t('sidepanel.browserControlPage.includeSnapshot')}
          description={t('sidepanel.browserControlPage.includeSnapshotDescription')}
          checked={settings.includeSnapshotAfterActions}
          disabled={busy !== 'idle'}
          onChange={(checked) => savePatch({ includeSnapshotAfterActions: checked })}
        />
        <NumberField
          label={t('sidepanel.browserControlPage.maxNodes')}
          value={settings.maxSnapshotNodes}
          min={50}
          max={1500}
          step={50}
          disabled={busy !== 'idle'}
          onChange={(value) => savePatch({ maxSnapshotNodes: value })}
        />
        <NumberField
          label={t('sidepanel.browserControlPage.maxBytes')}
          value={settings.maxSnapshotTextBytes}
          min={4000}
          max={80000}
          step={4000}
          disabled={busy !== 'idle'}
          onChange={(value) => savePatch({ maxSnapshotTextBytes: value })}
        />
      </section>
    </div>
  );
}

function StatusGrid({
  attached,
  enabled,
  target,
}: {
  attached: boolean;
  enabled: boolean;
  target: BrowserControlTarget | null;
}) {
  const { t } = useI18n();
  const items = [
    { label: t('sidepanel.browserControlPage.status.enabled'), value: enabled ? t('common.enabled') : t('common.disabled') },
    { label: t('sidepanel.browserControlPage.status.attached'), value: attached ? t('common.enabled') : t('common.disabled') },
    { label: t('sidepanel.browserControlPage.status.target'), value: target ? String(target.id) : t('common.none') },
  ];
  return (
    <div className="grid grid-cols-3 gap-2">
      {items.map((item) => (
        <div key={item.label} className="rounded-lg px-3 py-2" style={{ background: 'var(--ds-surface)' }}>
          <div className="text-[10px]" style={{ color: 'var(--ds-text-tertiary)' }}>{item.label}</div>
          <div className="text-xs font-medium truncate" style={{ color: 'var(--ds-text)' }}>{item.value}</div>
        </div>
      ))}
    </div>
  );
}

function TargetRow({
  target,
  selected,
  disabled,
  onSelect,
}: {
  target: BrowserControlTarget;
  selected: boolean;
  disabled: boolean;
  onSelect: () => void;
}) {
  const { t } = useI18n();
  return (
    <button
      type="button"
      onClick={onSelect}
      disabled={disabled || !target.controllable}
      className="ds-surface-panel w-full rounded-xl p-3 text-left disabled:opacity-60"
      style={{
        borderColor: selected ? 'var(--ds-blue)' : 'var(--ds-border)',
      }}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-xs font-medium truncate" style={{ color: 'var(--ds-text)' }}>
            {target.title || t('sidepanel.browserControlPage.untitled')}
          </div>
          <div className="text-[10px] mt-1 truncate" style={{ color: 'var(--ds-text-tertiary)' }}>
            {target.url || t('sidepanel.browserControlPage.noUrl')}
          </div>
          {target.groupName && (
            <div className="text-[10px] mt-1" style={{ color: 'var(--ds-text-tertiary)' }}>
              {t('sidepanel.browserControlPage.group', { name: target.groupName })}
            </div>
          )}
          {!target.controllable && (
            <div className="text-[10px] mt-1" style={{ color: 'var(--ds-danger)' }}>
              {target.reason}
            </div>
          )}
        </div>
        <span className="text-[10px] shrink-0 px-2 py-1 rounded-md" style={{
          color: selected ? 'var(--ds-blue)' : 'var(--ds-text-tertiary)',
          background: selected ? 'var(--ds-blue-soft)' : 'var(--ds-surface)',
        }}>
          {selected ? t('sidepanel.browserControlPage.selected') : `#${target.id}`}
        </span>
      </div>
    </button>
  );
}

function ToggleRow({
  label,
  description,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  description: string;
  checked: boolean;
  disabled: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0">
        <div className="text-xs font-medium" style={{ color: 'var(--ds-text)' }}>{label}</div>
        <div className="text-[11px] mt-0.5 leading-relaxed" style={{ color: 'var(--ds-text-secondary)' }}>{description}</div>
      </div>
      <button
        type="button"
        onClick={() => onChange(!checked)}
        disabled={disabled}
        className="relative shrink-0 w-10 h-[22px] rounded-full transition-colors duration-200 disabled:opacity-50"
        style={{ background: checked ? 'var(--ds-blue)' : 'var(--ds-border)' }}
        aria-label={label}
      >
        <span
          className="ds-switch-thumb absolute top-[3px] left-[3px] w-4 h-4 rounded-full transition-transform duration-200"
          style={{ transform: checked ? 'translateX(18px)' : 'translateX(0)' }}
        />
      </button>
    </div>
  );
}

function NumberField({
  label,
  value,
  min,
  max,
  step,
  disabled,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  disabled: boolean;
  onChange: (value: number) => void;
}) {
  return (
    <label className="block space-y-1">
      <span className="text-xs font-medium" style={{ color: 'var(--ds-text)' }}>{label}</span>
      <input
        type="number"
        value={value}
        min={min}
        max={max}
        step={step}
        disabled={disabled}
        onChange={(event) => {
          const next = Number(event.target.value);
          if (Number.isFinite(next)) onChange(next);
        }}
        className="w-full px-3 py-2 text-xs rounded-lg border outline-none transition-colors focus:border-[var(--ds-blue)] disabled:opacity-50"
        style={{
          background: 'var(--ds-bg)',
          borderColor: 'var(--ds-border)',
          color: 'var(--ds-text)',
        }}
      />
    </label>
  );
}
