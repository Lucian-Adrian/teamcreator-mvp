import test from 'node:test';
import assert from 'node:assert/strict';
import { getMemberAvatar } from './member-avatar';
import fixture from './public-demo-fixture.json';
import type { ProjectRecord } from '../../shared/types';

test('all synthetic people receive distinct portraits without changing real people or custom photos', () => {
  const members = fixture.members as unknown as ProjectRecord[];
  const positions = members.map(member => getMemberAvatar(member, true)?.style.backgroundPosition);
  assert.equal(new Set(positions).size, 10);
  const noPhoto = { ...members[8], avatar_asset: undefined, avatar_is_illustrative: undefined };
  assert.equal(getMemberAvatar(noPhoto, false), null);
  const actualPhoto = getMemberAvatar({ ...noPhoto, avatar_asset: '/uploads/custom-photo.png' }, true);
  assert.equal(actualPhoto?.style.backgroundImage, 'url(/uploads/custom-photo.png)');
});
