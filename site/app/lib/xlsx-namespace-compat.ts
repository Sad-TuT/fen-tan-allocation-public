import JSZip from 'jszip';

// ExcelJS 4.4 assumes spreadsheet XML uses unprefixed element names. OOXML
// permits namespace prefixes, however. Normalize only the in-memory copy, and
// only when every namespace declaration and element is safe to reinterpret.
const spreadsheetNamespace = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const xmlToken = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<![^>]*>|<\/?(?:[^>"']|"[^"]*"|'[^']*')*>/g;

function normalizeSpreadsheetXml(xml: string): string | null {
  const tokens = xml.match(xmlToken) ?? [];
  const root = tokens.find(t => /^<[A-Za-z_]/.test(t));
  if (!root) return null;
  const prefix = /^<([A-Za-z_][\w.-]*):[\w.-]+(?:\s|\/?>)/.exec(root)?.[1];
  if (!prefix) return null;
  const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const prefixDecl = new RegExp(`\\sxmlns:${escaped}\\s*=\\s*(["'])(.*?)\\1`, 'g');
  const defaultDecl = /\sxmlns\s*=\s*(["'])(.*?)\1/g;
  const rootDeclaration = [...root.matchAll(prefixDecl)].map(m => m[2]);
  if (rootDeclaration.length !== 1 || rootDeclaration[0] !== spreadsheetNamespace) return null;
  const declarations = tokens.flatMap(t => [...t.matchAll(prefixDecl)].map(m => m[2]));
  if (declarations.length !== 1 || declarations[0] !== spreadsheetNamespace) throw new Error('Excel 表格包含不能安全兼容的命名空间重绑定，请另存为标准 xlsx 后重试。');
  const defaults = tokens.flatMap(t => [...t.matchAll(defaultDecl)].map(m => m[2]));
  if (defaults.some(v => v !== spreadsheetNamespace)) throw new Error('Excel 表格包含不能安全兼容的默认命名空间，请另存为标准 xlsx 后重试。');
  const rootHasDefault = /\sxmlns\s*=/.test(root);
  // Introducing a default namespace would otherwise alter unprefixed nodes.
  if (!rootHasDefault && tokens.some(t => /^<\/?[A-Za-z_][\w.-]*(?=\s|\/?>)/.test(t))) throw new Error('Excel 表格包含不能安全兼容的无前缀元素，请另存为标准 xlsx 后重试。');
  const element = new RegExp(`^(</?)${escaped}:`);
  let replacedRoot = false;
  return xml.replace(xmlToken, token => {
    if (!element.test(token)) return token;
    let result = token.replace(element, '$1');
    if (!replacedRoot && token === root) {
      replacedRoot = true;
      if (!rootHasDefault) result = result.replace(/^(<[\w.-]+)/, `$1 xmlns="${spreadsheetNamespace}"`);
    }
    return result;
  });
}

export async function normalizeSpreadsheetNamespaces(bytes: Uint8Array): Promise<Uint8Array | null> {
  const zip = await JSZip.loadAsync(bytes);
  let changed = false;
  for (const [name, entry] of Object.entries(zip.files)) {
    if (entry.dir || !/^xl\/(?:workbook|styles|sharedStrings|worksheets\/[^/]+)\.xml$/.test(name)) continue;
    const xml = await entry.async('string');
    const normalized = normalizeSpreadsheetXml(xml);
    if (normalized !== null) { zip.file(name, normalized); changed = true; }
  }
  return changed ? zip.generateAsync({ type: 'uint8array' }) : null;
}
