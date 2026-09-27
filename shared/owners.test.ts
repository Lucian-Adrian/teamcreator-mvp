import assert from 'node:assert/strict';
import test from 'node:test';
import { isUnknownOwnerLabel } from './owners.js';

test('recognizes exact English and Romanian unknown-owner labels', () => {
  for (const label of [
    'Unassigned', ' not assigned ', 'TBD', 'to be determined', 'unknown owner', 'not recorded',
    'N/A', 'N-A', 'unowned', 'neatribuit', 'NEATRIBUITĂ', 'necunoscut', 'necunoscută',
    'nespecificat', 'nespecificată', 'nu este atribuit', 'de stabilit', '"Unknown."',
  ]) {
    assert.equal(isUnknownOwnerLabel(label), true, label);
  }
});

test('does not classify real owner or organization names by substring', () => {
  for (const label of [
    'Asterion Client IT', 'TBD Engineering', 'N-A Logistics', 'Unknown Waters Team',
    'Nika Unassigned Transport', 'Tidepath Imaging Cooperative', 'No Owner Records Ltd',
  ]) {
    assert.equal(isUnknownOwnerLabel(label), false, label);
  }
});

test('missing or blank values are not explicit owner-clearing instructions', () => {
  for (const value of [undefined, null, '', '   ']) {
    assert.equal(isUnknownOwnerLabel(value), false);
  }
});
