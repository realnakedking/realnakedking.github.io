// Работа с GitHub прямо из браузера. Ключ живёт только в памяти этой вкладки.
const API = 'https://api.github.com';

export class GitHubError extends Error {
  constructor(status, detail) { super(detail || `Ошибка GitHub ${status}`); this.status = status; this.detail = detail || ''; }
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result).split(',')[1] || '');
    fr.onerror = () => reject(fr.error);
    fr.readAsDataURL(blob);
  });
}
export function textToBase64(text) {
  const bytes = new TextEncoder().encode(text);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export class GitHub {
  constructor(token) { this.token = token; }

  async req(method, path, { body, raw } = {}) {
    let res;
    try {
      res = await fetch(API + path, {
        method,
        cache: 'no-store',
        headers: {
          Authorization: `Bearer ${this.token}`,
          Accept: raw ? 'application/vnd.github.raw+json' : 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch {
      throw new GitHubError(0, 'Нет связи с GitHub. Проверьте интернет и попробуйте ещё раз.');
    }
    if (!res.ok) {
      let detail = '';
      try { detail = (await res.json()).message || ''; } catch { /* тело не JSON */ }
      throw new GitHubError(res.status, detail);
    }
    if (raw === 'blob') return res.blob();
    if (raw) return res.text();
    return res.status === 204 ? null : res.json();
  }

  repo(name) { return this.req('GET', `/repos/${name}`); }

  // Снимок ветки: последняя публикация и список всех файлов.
  async snapshot(name, branch) {
    const ref = await this.req('GET', `/repos/${name}/git/ref/heads/${branch}`);
    const head = ref.object.sha;
    const commit = await this.req('GET', `/repos/${name}/git/commits/${head}`);
    const tree = await this.req('GET', `/repos/${name}/git/trees/${commit.tree.sha}?recursive=1`);
    const files = new Map();
    for (const t of tree.tree) if (t.type === 'blob') files.set(t.path, t.sha);
    return { head, treeSha: commit.tree.sha, files };
  }

  path(p) { return p.split('/').map(encodeURIComponent).join('/'); }
  text(name, p, ref) { return this.req('GET', `/repos/${name}/contents/${this.path(p)}?ref=${ref}`, { raw: true }); }
  blob(name, p, ref) { return this.req('GET', `/repos/${name}/contents/${this.path(p)}?ref=${ref}`, { raw: 'blob' }); }

  // Одна публикация со всеми файлами сразу. Пока не выполнен последний шаг (перевод ветки
  // на новую версию), снаружи ничего не меняется: при любой ошибке всё остаётся как было.
  // entries: [{ path, text } | { path, blob } | { path, remove: true }]
  async commit(name, branch, snap, entries, message, onStep) {
    const tree = [];
    let n = 0;
    for (const e of entries) {
      onStep && onStep(++n, entries.length);
      if (e.remove) { tree.push({ path: e.path, mode: '100644', type: 'blob', sha: null }); continue; }
      const content = e.blob ? await blobToBase64(e.blob) : textToBase64(e.text);
      const b = await this.req('POST', `/repos/${name}/git/blobs`, { body: { content, encoding: 'base64' } });
      tree.push({ path: e.path, mode: '100644', type: 'blob', sha: b.sha });
    }
    const t = await this.req('POST', `/repos/${name}/git/trees`, { body: { base_tree: snap.treeSha, tree } });
    const c = await this.req('POST', `/repos/${name}/git/commits`, { body: { message, tree: t.sha, parents: [snap.head] } });
    // Без force: если ветку за это время изменил кто-то ещё, GitHub откажет, и чужие изменения не затрутся.
    await this.req('PATCH', `/repos/${name}/git/refs/heads/${branch}`, { body: { sha: c.sha, force: false } });
    return c.sha;
  }

  // Первый файл в совсем пустом хранилище (обычный способ там не работает).
  initFile(name, p, text, message) {
    return this.req('PUT', `/repos/${name}/contents/${this.path(p)}`, { body: { message, content: textToBase64(text) } });
  }

  history(name, p, n = 20) { return this.req('GET', `/repos/${name}/commits?path=${encodeURIComponent(p)}&per_page=${n}`); }
}
