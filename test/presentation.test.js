import test from 'node:test';
import assert from 'node:assert/strict';
import { BRAND_NAME, EMBED_LIMITS, chunkLines, normalizeFooter, safeField, truncateText } from '../src/utils/presentation.js';

test('footer normalization never exposes Discord snowflakes', () => {
  assert.equal(normalizeFooter('123456789012345678'), BRAND_NAME);
  assert.equal(normalizeFooter(undefined), BRAND_NAME);
  assert.equal(normalizeFooter('The Republic'), 'The Republic');
});

test('line pagination respects Discord description and embed-count limits', () => {
  const pages = chunkLines(Array.from({ length: 100 }, (_, index) => `${index}: ${'x'.repeat(150)}`));
  assert.ok(pages.length <= EMBED_LIMITS.embeds);
  assert.ok(pages.every(page => page.length <= 3900));
});

test('field and description text are bounded safely', () => {
  assert.equal(truncateText('abcdef', 4), 'abc…');
  const field = safeField('n'.repeat(400), 'v'.repeat(2000), true);
  assert.equal(field.name.length, 256);
  assert.equal(field.value.length, EMBED_LIMITS.field);
  assert.equal(field.inline, true);
});
