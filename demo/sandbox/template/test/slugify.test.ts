import { expect, test } from 'vitest';
import { slugify } from '../src/slugify.js';

test('returns a lowercase word', () => {
  expect(slugify('Hello')).toBe('hello');
});
