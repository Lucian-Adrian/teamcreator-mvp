import { createContext, type CSSProperties } from 'react';
import type { ProjectRecord } from '../../shared/types';

export const MemberAvatarContext = createContext(false);
const demoPortraits = ['Elena Rusu', 'Victor Munteanu', 'Irina Ceban', 'Mihai Lungu', 'Sofia Dinu', 'Andrei Rotaru', 'Dana Moraru', 'Radu Ionescu', 'Ioana Popa', 'Oleg Balan'];

/** Generated portraits are presentation assets, never inferred employee photos. */
export function getMemberAvatar(member: ProjectRecord | null | undefined, synthetic = false): { style: CSSProperties; illustrative: boolean } | null {
  if (!member) return null;
  const index = synthetic ? demoPortraits.indexOf(member.title) : -1;
  if (index >= 0 && (!member.avatar_asset || member.avatar_is_illustrative)) return {
    style: { backgroundImage: 'url(/brand/team-portraits-v2.png)', backgroundSize: '500% 200%', backgroundPosition: `${(index % 5) * 25}% ${index < 5 ? 0 : 100}%` },
    illustrative: true,
  };
  if (!member.avatar_asset) return null;
  let crop = member.avatar_crop;
  if (member.avatar_is_illustrative && crop === 'bottom-left') crop = 'bottom-right';
  else if (member.avatar_is_illustrative && crop === 'bottom-right') crop = 'bottom-left';
  return { style: { backgroundImage: `url(${member.avatar_asset})`, backgroundSize: crop ? '200% 200%' : 'cover', backgroundPosition: crop ? { 'top-left': '0% 0%', 'top-right': '100% 0%', 'bottom-left': '0% 100%', 'bottom-right': '100% 100%' }[crop] : 'center' }, illustrative: Boolean(member.avatar_is_illustrative) };
}
