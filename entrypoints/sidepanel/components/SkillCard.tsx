import type { LocaleMessageKey } from '../../../core/i18n';
import type { Skill } from '../../../core/types';
import { SVG_PATHS } from '../constants';
import { useI18n } from '../i18n';

interface Props {
  skill: Skill;
  onEdit?: () => void;
  onDelete?: () => void;
  onToggleEnabled?: () => void;
}

const SOURCE_LABELS: Record<string, { labelKey: LocaleMessageKey; className: string }> = {
  builtin: { labelKey: 'sidepanel.skill.sources.builtin', className: 'ds-badge-info' },
  official: { labelKey: 'sidepanel.skill.sources.official', className: 'ds-badge-warning' },
  'third-party': { labelKey: 'sidepanel.skill.sources.thirdParty', className: 'ds-badge-warning' },
  custom: { labelKey: 'sidepanel.skill.sources.custom', className: 'ds-badge-warning' },
  remote: { labelKey: 'sidepanel.skill.sources.remote', className: 'ds-badge-info' },
};

export default function SkillCard({ skill, onEdit, onDelete, onToggleEnabled }: Props) {
  const { t } = useI18n();
  const badge = skill.remote?.provider === 'local'
    ? { labelKey: 'sidepanel.skill.sources.local' as LocaleMessageKey, className: 'ds-badge-success' }
    : SOURCE_LABELS[skill.source];
  const enabled = skill.enabled !== false;
  const hasActions = Boolean(onEdit || onDelete || onToggleEnabled);
  const toggleLabel = enabled
    ? t('sidepanel.skill.actions.disableSkill', { name: skill.name })
    : t('sidepanel.skill.actions.enableSkill', { name: skill.name });

  return (
    <div className="ds-card rounded-xl p-3.5 group" style={!enabled ? { opacity: 0.68 } : undefined}>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 min-w-0">
          <code className="ds-trigger text-[12px] font-mono font-semibold px-1.5 py-0.5 rounded">
            /{skill.name}
          </code>
          {badge && (
            <span className={`${badge.className} inline-flex items-center text-[10px] px-1.5 py-0.5 rounded-full font-medium`}>
              {t(badge.labelKey)}
            </span>
          )}
          {!enabled && (
            <span className="ds-badge-warning inline-flex items-center text-[10px] px-1.5 py-0.5 rounded-full font-medium">
              {t('sidepanel.skill.disabledBadge')}
            </span>
          )}
        </div>
        {hasActions && (
          <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-all duration-150">
            {onToggleEnabled && (
              <button
                type="button"
                title={enabled ? t('common.deactivate') : t('common.enable')}
                aria-label={toggleLabel}
                onClick={onToggleEnabled}
                className="ds-action-btn ds-action-btn-edit w-7 h-7 rounded-lg flex items-center justify-center"
              >
                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d={enabled ? 'M18.364 18.364A9 9 0 015.636 5.636m12.728 12.728A9 9 0 005.636 5.636m12.728 12.728L5.636 5.636' : 'M5 13l4 4L19 7'} />
                </svg>
              </button>
            )}
            {onEdit && (
              <button
                type="button"
                title={t('common.edit')}
                aria-label={t('sidepanel.skill.actions.editSkill', { name: skill.name })}
                onClick={onEdit}
                className="ds-action-btn ds-action-btn-edit w-7 h-7 rounded-lg flex items-center justify-center"
              >
                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d={SVG_PATHS.edit} />
                </svg>
              </button>
            )}
            {onDelete && (
              <button
                type="button"
                title={t('common.delete')}
                aria-label={t('sidepanel.skill.actions.deleteSkill', { name: skill.name })}
                onClick={onDelete}
                className="ds-action-btn ds-action-btn-delete w-7 h-7 rounded-lg flex items-center justify-center"
              >
                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d={SVG_PATHS.trash} />
                </svg>
              </button>
            )}
          </div>
        )}
      </div>
      <p className="text-xs mt-1.5 leading-relaxed" style={{ color: 'var(--ds-text-secondary)' }}>
        {skill.description}
      </p>
      {skill.remote && (
        <div className="flex flex-wrap gap-1.5 mt-2 text-[10px]" style={{ color: 'var(--ds-text-tertiary)' }}>
          <span className="ds-tag px-1.5 py-0.5 rounded-full">
            {skill.remote.provider === 'local'
              ? skill.remote.localDisplayName ?? t('sidepanel.skill.sources.local')
              : skill.remote.repository}
          </span>
          <span className="ds-tag px-1.5 py-0.5 rounded-full">
            {skill.remote.path}
          </span>
          {skill.remote.provider === 'local' ? (
            <span className="ds-tag px-1.5 py-0.5 rounded-full">
              {skill.remote.localDirectory ?? skill.remote.localRootPath}
            </span>
          ) : (
            <span className="ds-tag px-1.5 py-0.5 rounded-full">
              {skill.remote.licenseSpdxId ?? skill.remote.licenseName ?? t('sidepanel.skill.unknownLicense')}
            </span>
          )}
          {skill.remote.upstreamVersion && (
            <span className="ds-tag px-1.5 py-0.5 rounded-full">
              v{skill.remote.upstreamVersion}
            </span>
          )}
        </div>
      )}
      {skill.memoryEnabled && (
        <span className="ds-badge-success inline-flex items-center gap-1 mt-2 text-[10px] px-2 py-0.5 rounded-full font-medium">
          <svg className="w-2.5 h-2.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d={SVG_PATHS.chip} />
          </svg>
          {t('sidepanel.skill.memoryEnabledBadge')}
        </span>
      )}
    </div>
  );
}
