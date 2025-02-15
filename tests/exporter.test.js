import Exporter from '../src/exporter';
import { describe, it, expect } from "bun:test";

describe('looksLikePaper', () => {
  it('should return true for a Paper-looking object', () => {
    const entry = {
      '.tag': 'file',
      is_downloadable: false,
      name: 'foo.paper',
      export_info: { export_options: ['markdown'] }
    };
    expect(Exporter.looksLikePaper(entry)).toBe(true);
  });
});
