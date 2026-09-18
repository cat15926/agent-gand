import type { AgentDefinition } from '@agent-gand/shared';

interface AgentAvatarProps {
  agent?: AgentDefinition;
  label?: string;
  color?: string;
  className?: string;
  imageClassName?: string;
}

export function AgentAvatar({ agent, label, color, className = 'h-9 w-9 text-sm', imageClassName = '' }: AgentAvatarProps) {
  const name = agent?.name ?? label ?? 'Agent';
  const avatar = agent?.avatar?.trim() ?? '';
  const imageUrl = /^(?:https:\/\/\S+|\/api\/agent-avatars\/[0-9a-f-]+\.(?:png|jpg|webp|gif)|blob:.+)$/i.test(avatar) ? avatar : null;
  const fallback = avatar && !imageUrl ? avatar : (Array.from(name)[0] ?? 'A').toUpperCase();
  return <span
    className={`relative inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full font-semibold text-white ${className}`}
    style={{ backgroundColor: agent?.color ?? color ?? '#52525b' }}
    title={name}
  >
    <span className="select-none leading-none">{fallback}</span>
    {imageUrl && <img src={imageUrl} alt={`${name} 的头像`} className={`absolute inset-0 h-full w-full object-cover ${imageClassName}`} onError={(event) => { event.currentTarget.hidden = true; }} />}
  </span>;
}
