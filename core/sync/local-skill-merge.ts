import type { Skill, SkillImportSource, LocalSkillSource } from '../types';

interface SkillImportSnapshot {
  skills: Skill[];
  skillSources: SkillImportSource[];
}

export function mergeLocalSkillImportsIntoSyncSnapshot(
  snapshot: SkillImportSnapshot,
  localState: SkillImportSnapshot,
): SkillImportSnapshot {
  const occupiedNames = new Set(snapshot.skills.map((skill) => skill.name));
  const localSkills = localState.skills.filter(isLocalImportedSkill);
  const localNameBySourcePath = new Map<string, string>();

  const mergedLocalSkills = localSkills.map((skill) => {
    const nextName = createAvailableSkillName(skill.name, occupiedNames);
    occupiedNames.add(nextName);
    localNameBySourcePath.set(sourcePathKey(skill.remote.sourceId, skill.remote.path), nextName);
    return nextName === skill.name ? skill : { ...skill, name: nextName };
  });

  const mergedLocalSources = localState.skillSources
    .filter(isLocalSkillSource)
    .map((source) => ({
      ...source,
      importedSkillNames: source.skillPaths
        .map((path) => localNameBySourcePath.get(sourcePathKey(source.id, path)))
        .filter((name): name is string => Boolean(name)),
    }));

  return {
    skills: [
      ...snapshot.skills,
      ...mergedLocalSkills,
    ],
    skillSources: [
      ...snapshot.skillSources,
      ...mergedLocalSources,
    ],
  };
}

function isLocalImportedSkill(skill: Skill): skill is Skill & {
  remote: NonNullable<Skill['remote']> & { provider: 'local' };
} {
  return skill.source === 'remote' && skill.remote?.provider === 'local';
}

function isLocalSkillSource(source: SkillImportSource): source is LocalSkillSource {
  return source.provider === 'local';
}

function createAvailableSkillName(preferred: string, occupiedNames: Set<string>): string {
  const base = preferred.trim();
  if (!base) throw new Error('Local Skill cannot be merged because its name is empty.');
  if (!occupiedNames.has(base)) return base;

  for (let suffix = 2; suffix < 1000; suffix += 1) {
    const candidate = `${base}-${suffix}`;
    if (!occupiedNames.has(candidate)) return candidate;
  }
  throw new Error(`Unable to generate a unique name for local Skill: ${preferred}`);
}

function sourcePathKey(sourceId: string, path: string): string {
  return `${sourceId}\n${path}`;
}
