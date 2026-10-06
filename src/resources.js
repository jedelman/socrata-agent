// Everything the agent touched, gathered for the operator so they can pick up
// where the agent stops: dataset pages, full downloads, the exact filtered
// query as CSV, meeting records, and the people to contact.

export class Resources {
  constructor() {
    this.datasets = new Map(); // id -> { id, name, page, docs, csv, department, queries: [] }
    this.records = new Map(); // url -> { title, url, kind }
    this.contacts = new Map(); // key -> { role, name, email, phone, url, source }
    this.links = new Map(); // url -> { title, url }
  }

  addDataset(d) {
    const cur = this.datasets.get(d.id) || { queries: [] };
    this.datasets.set(d.id, { ...cur, ...d, queries: cur.queries });
  }

  addQuery(id, csvUrl) {
    const d = this.datasets.get(id);
    if (d && !d.queries.includes(csvUrl)) d.queries.push(csvUrl);
  }

  addRecord(r) {
    this.records.set(r.url, r);
  }

  addContact(c) {
    if (!c.name && !c.email && !c.phone && !c.url) return;
    this.contacts.set(`${c.role}|${c.name || c.email || c.phone}`, c);
  }

  addLink(l) {
    this.links.set(l.url, l);
  }

  // Contacts specific to the address first, citywide ones after.
  sortedContacts() {
    const all = [...this.contacts.values()];
    return [...all.filter((c) => c.source !== 'city profile'), ...all.filter((c) => c.source === 'city profile')];
  }

  toJSON() {
    return {
      datasets: [...this.datasets.values()],
      records: [...this.records.values()],
      contacts: this.sortedContacts(),
      links: [...this.links.values()],
    };
  }

  toMarkdown() {
    const out = [];
    const ds = [...this.datasets.values()];
    if (ds.length) {
      out.push('**Datasets**');
      for (const d of ds) {
        const parts = [`[page](${d.page})`, `[download CSV](${d.csv})`, `[API docs](${d.docs})`];
        d.queries.forEach((q, i) => parts.push(`[these rows${d.queries.length > 1 ? ` (${i + 1})` : ''} as CSV](${q})`));
        out.push(`- ${d.name || d.id} (\`${d.id}\`)${d.department ? `, from ${d.department}` : ''}: ${parts.join(' · ')}`);
      }
    }
    const recs = [...this.records.values()];
    if (recs.length) {
      out.push('**Public records**');
      for (const r of recs) out.push(`- [${r.title}](${r.url})`);
    }
    const cs = this.sortedContacts();
    if (cs.length) {
      out.push('**Contacts**');
      for (const c of cs) {
        const bits = [c.email && `<${c.email}>`, c.phone, c.url && `[site](${c.url})`, c.note].filter(Boolean);
        out.push(`- ${c.role}: ${[c.name, ...bits].filter(Boolean).join(' · ')}`);
      }
    }
    const ls = [...this.links.values()];
    if (ls.length) {
      out.push('**Go further**');
      for (const l of ls) out.push(`- [${l.title}](${l.url})`);
    }
    return out.join('\n');
  }
}
