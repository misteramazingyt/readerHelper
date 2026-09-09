// todoist.js — Todoist client.
//
// Todoist unified its REST surface at /api/v1 (paginated {results,next_cursor});
// the older /rest/v2 returns bare arrays and is still live. We try v1 first and
// fall back once per session, then normalise both into plain arrays.
//
// Mapping, per the Todoist conventions this board now follows:
//   readerHelper Project (sidebar) -> Todoist Project
//   readerHelper Group  (column)   -> Todoist Section
//   readerHelper Book              -> Todoist Task

const V1 = 'https://api.todoist.com/api/v1';
const V2 = 'https://api.todoist.com/rest/v2';

let base = V1;
let fellBack = false;

export class TodoistError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'TodoistError';
    this.status = status;
  }
}

async function call(cfg, path, { method = 'GET', body, query } = {}) {
  if (!cfg?.todoistApiKey) throw new TodoistError('No Todoist API token configured.', 0);
  const run = async (root) => {
    let url = `${root}${path}`;
    if (query && Object.keys(query).length) {
      const qs = new URLSearchParams(
        Object.entries(query).filter(([, v]) => v !== undefined && v !== null),
      );
      url += `?${qs}`;
    }
    return fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${cfg.todoistApiKey}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(body ? { 'X-Request-Id': crypto.randomUUID() } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  };

  let res = await run(base);
  if (res.status === 404 && base === V1 && !fellBack) {
    fellBack = true;
    base = V2;
    res = await run(base);
  }
  if (res.status === 401 || res.status === 403) {
    throw new TodoistError('Todoist rejected the API token.', res.status);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new TodoistError(`Todoist ${res.status}: ${text.slice(0, 200)}`, res.status);
  }
  if (res.status === 204) return null;
  return res.json();
}

/** Both API shapes -> a plain array, following v1 cursors to the end. */
async function callList(cfg, path, query = {}) {
  const out = [];
  let cursor = null;
  for (;;) {
    const data = await call(cfg, path, { query: { ...query, cursor, limit: 200 } });
    if (Array.isArray(data)) return data;
    out.push(...(data?.results || []));
    cursor = data?.next_cursor || null;
    if (!cursor) break;
  }
  return out;
}

export async function verifyToken(cfg) {
  const projects = await listProjects(cfg);
  return { ok: true, projectCount: projects.length };
}

// ----------------------------------------------------------------- projects

export async function listProjects(cfg) {
  return callList(cfg, '/projects');
}

export async function findInboxProject(cfg) {
  const projects = await listProjects(cfg);
  return projects.find((p) => p.is_inbox_project || p.inbox_project) || projects[0] || null;
}

export async function createProject(cfg, name) {
  return call(cfg, '/projects', { method: 'POST', body: { name } });
}

export async function deleteProject(cfg, projectId) {
  return call(cfg, `/projects/${projectId}`, { method: 'DELETE' });
}

/** Reuse a Todoist project with this exact name before creating a duplicate. */
export async function ensureProject(cfg, name) {
  const projects = await listProjects(cfg);
  const hit = projects.find((p) => (p.name || '').toLowerCase() === name.toLowerCase());
  if (hit) return hit;
  return createProject(cfg, name);
}

// ----------------------------------------------------------------- sections

export async function listSections(cfg, projectId) {
  return callList(cfg, '/sections', { project_id: projectId });
}

export async function createSection(cfg, name, projectId) {
  return call(cfg, '/sections', { method: 'POST', body: { name, project_id: projectId } });
}

export async function deleteSection(cfg, sectionId) {
  return call(cfg, `/sections/${sectionId}`, { method: 'DELETE' });
}

export async function ensureSection(cfg, name, projectId) {
  const sections = await listSections(cfg, projectId);
  const hit = sections.find((s) => (s.name || '').toLowerCase() === name.toLowerCase());
  if (hit) return hit;
  return createSection(cfg, name, projectId);
}

// -------------------------------------------------------------------- tasks

export async function createTask(cfg, payload) {
  const body = {
    content: payload.content,
    description: payload.description || undefined,
    project_id: payload.projectId || undefined,
    section_id: payload.sectionId || undefined,
    due_string: payload.dueString || undefined,
    priority: payload.priority || undefined,
    labels: payload.labels?.length ? payload.labels : undefined,
  };
  return call(cfg, '/tasks', { method: 'POST', body });
}

export async function closeTask(cfg, taskId) {
  return call(cfg, `/tasks/${taskId}/close`, { method: 'POST' });
}

// -------------------------------------------------------------- composition

/**
 * Todoist renders Markdown in task content, so the book becomes a clickable
 * link. Prefer the DOI, then the item URL, then a zotero:// deep link, which
 * still resolves on this machine even though Todoist cannot follow it.
 */
export function bookLink(item) {
  if (item.doi) return `https://doi.org/${String(item.doi).replace(/^https?:\/\/doi\.org\//, '')}`;
  if (item.url) return item.url;
  if (item.citekey) return `zotero://select/items/@${encodeURIComponent(item.citekey)}`;
  if (item.zoteroKey && item.zoteroLibrary) {
    return `zotero://select/library/items/${item.zoteroKey}`;
  }
  return null;
}

export function defaultTaskForItem(item, { progressPct } = {}) {
  const link = bookLink(item);
  const authors = item.authors?.length ? item.authors.join(', ') : '';
  const title = item.title || 'Untitled';
  const content = link ? `Read [${title}](${link})` : `Read ${title}`;
  const lines = [];
  if (authors) lines.push(authors + (item.year ? ` (${item.year})` : ''));
  else if (item.year) lines.push(String(item.year));
  if (item.totalPages) {
    lines.push(`${item.currentPage || 0} / ${item.totalPages} pp${progressPct ? ` — ${progressPct}` : ''}`);
  } else if (progressPct) {
    lines.push(progressPct);
  }
  if (item.tag) lines.push(`Mode: ${item.tag}`);
  if (link) lines.push(link);
  return { content, description: lines.join('\n') };
}

export function defaultTaskForContainer(name, kind) {
  return {
    content: `Finish ${name}`,
    description: `readerHelper ${kind}: ${name}`,
  };
}
