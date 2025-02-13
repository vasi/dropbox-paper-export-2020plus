import { looksLikePaper } from '../src/paper';
import { describe, it, expect } from "bun:test";

describe('looksLikePaper', () => {
  it('should return true for a Paper-looking object', () => {
    const entry = {
      '.tag': 'file',
      is_downloadable: false,
      name: 'foo.paper',
      export_info: { export_options: ['markdown'] }
    };
    expect(looksLikePaper(entry)).toBe(true);
  });
});
