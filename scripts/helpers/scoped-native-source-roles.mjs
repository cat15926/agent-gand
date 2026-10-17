import {createHash} from 'node:crypto';

export const sourceRoleDigest = definition => createHash('sha256').update(JSON.stringify(definition)).digest('hex');

/** A resumed supplier test must keep the human-selected role, not just its account. */
export function assertFrozenSourceRoles(source, roles, selectedIds) {
  if (!Array.isArray(roles) || roles.length !== selectedIds.length || new Set(selectedIds).size !== selectedIds.length
    || roles.some(role => !selectedIds.includes(role.id))) throw new Error('SOURCE_ROLE_SELECTION_CHANGED');
  for (const frozen of roles) {
    const row = source.prepare('SELECT definition FROM agents WHERE id=? AND enabled=1').get(frozen.id);
    if (!row || sourceRoleDigest(JSON.parse(row.definition)) !== frozen.definitionDigest) throw new Error('SOURCE_ROLE_CHANGED');
  }
}
