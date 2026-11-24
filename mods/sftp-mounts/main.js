// SFTP mounts: rclone's sftp remotes, mounted as local folders so agents can
// edit a server that only speaks SFTP (no shell, so no `hc machine add`).
//
// rclone owns the connections (~/.config/rclone/rclone.conf); this mod is a
// face on it. Each mount is `rclone nfsmount` (no macFUSE, no sudo on macOS)
// running in a herdr-core terminal named `sftp-<remote>`, so it outlives the
// window and its log is one `hc read sftp-<remote>` away.
//
// Writes upload as soon as a file closes (--vfs-write-back 0s), and Unmount
// stops rclone with ctrl+c, which finishes uploads before it lets go. A plain
// `umount` can drop an upload still in the queue: don't use it while writing.
//
// Open with `mod.open sftp-mounts` or the palette's "SFTP mounts".

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { exec, hc, home, appHome, theme, props, closeOverlay, run, notify, checking } from "herdr";

const I = (name) => `mods/workspace-chrome/${name}.svg`;
const PREFS = "sftp-mounts";
const NAME_OK = /^[a-z0-9_-]{1,26}$/; // hc terminal names allow 32: "sftp-" + 26 + room
const term = (name) => `sftp-${name}`;

function loadPrefs() {
  try { return JSON.parse(localStorage.getItem(PREFS) ?? "{}") ?? {}; } catch { return {}; }
}

export default class SftpMounts extends View {
  init(_props, cx) {
    this.handle = cx.focus_handle();
    this.rclone = null;      // null: checking; false: missing; string: version
    this.remotes = null;     // [{ name, host, user, port, key_file }]
    this.mounted = new Set(); // mountpoints the OS reports
    this.running = {};       // remote -> hc terminal state ("live", ...)
    this.busy = {};          // remote -> "mounting" | "unmounting" | "removing" | "testing"
    this.error = {};         // remote -> text
    this.hostkey = {};       // remote -> { host, lines, fingerprints, trusting? } for an unknown host key
    this.confirmRemove = null;
    this.prefs = loadPrefs(); // remote -> { path, mountpoint }
    this.adding = false;
    this.addBusy = false;
    this.addError = null;
    this.fields = {};
    for (const [key, placeholder] of [
      ["name", "name (a-z 0-9 - _)"], ["host", "host or IP"], ["user", "user"], ["port", "22"],
      ["key", "key file (empty: ssh-agent)"], ["pass", "password (optional)"], ["path", "remote folder (empty: login folder)"],
    ]) {
      const s = InputState.new({ placeholder });
      s.on("change", (_e, cx) => cx.notify());
      s.on("submit", (_e, cx) => this.create(cx));
      this.fields[key] = s;
    }
    this.fields.pass.set_masked(true);
    if (checking()) return;
    cx.spawn(async (cx) => { await this.refresh(); cx.notify(); });
    cx.timer.every(4000, (cx) => {
      if (this.refreshing) return;
      cx.spawn(async (cx) => { await this.refresh(); cx.notify(); });
    });
  }

  savePrefs() { localStorage.setItem(PREFS, JSON.stringify(this.prefs)); }
  mountpoint(name) { return this.prefs[name]?.mountpoint || `${home()}/mnt/${name}`; }
  remotePath(name) { return (this.prefs[name]?.path ?? "").replace(/^\/+(?=.)/, "/"); }

  async refresh() {
    this.refreshing = true;
    try {
      if (!this.rclone) {
        const v = await exec("rclone", ["version"]).catch(() => null);
        this.rclone = v?.code === 0 ? v.stdout.split("\n")[0].trim() : false;
        if (!this.rclone) return;
      }
      const dump = await exec("rclone", ["config", "dump"]).catch(() => null);
      let conf = {};
      try { conf = JSON.parse(dump?.stdout || "{}"); } catch { conf = {}; }
      this.remotes = Object.entries(conf)
        .filter(([, c]) => c.type === "sftp")
        .map(([name, c]) => ({ name, host: c.host ?? "", user: c.user ?? "", port: c.port ?? "", key_file: c.key_file ?? "", ssh: c.ssh ?? "" }))
        .sort((a, b) => a.name.localeCompare(b.name));

      const m = await exec("mount", []).catch(() => null);
      this.mounted = new Set((m?.stdout ?? "").split("\n").map((l) => l.match(/ on (.+) \((?:nfs|fuse|macfuse|osxfuse)/)?.[1]).filter(Boolean));

      this.running = {};
      await Promise.all(this.remotes.map(async (r) => {
        const g = await hc(["get", term(r.name), "--json"]).catch(() => null);
        if (g?.code !== 0) return;
        try { this.running[r.name] = JSON.parse(g.stdout).state ?? "live"; } catch { /* gone */ }
      }));
    } finally {
      this.refreshing = false;
    }
  }

  isMounted(name) { return this.mounted.has(this.mountpoint(name)); }

  // Tail of a mount terminal's output, for errors.
  async log(name, lines = 12) {
    const r = await hc(["read", term(name), "--lines", String(lines)]).catch(() => null);
    return (r?.stdout ?? "").split("\n").filter((l) => l.trim()).slice(-lines).join("\n");
  }

  mount(name, cx) {
    if (this.busy[name]) return;
    this.busy[name] = "mounting";
    delete this.error[name];
    delete this.hostkey[name];
    cx.notify();
    cx.spawn(async (cx) => {
      const mp = this.mountpoint(name);
      try {
        await exec("mkdir", ["-p", mp]);
        // Notes for agents, beside the mounts (never inside one, so never uploaded).
        // CLAUDE.md is a symlink: Claude Code skips @-imports from outside the
        // project until approved. Existing files are left alone, so edits stick.
        await exec("sh", ["-c", 'd="$(dirname "$1")"; [ -e "$d/AGENTS.md" ] || cp "$2" "$d/AGENTS.md"; [ -e "$d/CLAUDE.md" ] || [ -L "$d/CLAUDE.md" ] || ln -s AGENTS.md "$d/CLAUDE.md"',
          "sh", mp, `${appHome()}/mods/sftp-mounts/AGENTS.mount.md`]).catch(() => null);
        // A finished terminal keeps its name until removed.
        if (this.running[name] && this.running[name] !== "live") await hc(["rm", term(name)]).catch(() => null);
        const r = await hc([
          "run", "--bg", "--json", "--no-parent", "--no-notify", "--name", term(name), "--label", `sftp.remote=${name}`, "--",
          "rclone", "nfsmount", `${name}:${this.remotePath(name)}`, mp,
          "--vfs-cache-mode", "full", "--vfs-write-back", "0s", "--dir-cache-time", "10s",
          "--volname", name,
        ]);
        if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim() || "hc run failed");
        // Up to 20 s for the server to answer and the mount to appear.
        for (let i = 0; i < 40; i++) {
          await exec("sleep", ["0.5"]);
          await this.refresh();
          if (this.isMounted(name)) break;
          if (this.running[name] && this.running[name] !== "live") break;
        }
        if (!this.isMounted(name)) {
          this.error[name] = (await this.log(name)) || "rclone didn't mount it.";
          await this.checkHostKey(name);
          await hc(["kill", term(name)]).catch(() => null);
          await hc(["rm", term(name)]).catch(() => null);
        }
      } catch (e) {
        this.error[name] = String(e?.message ?? e);
      }
      delete this.busy[name];
      await this.refresh();
      cx.notify();
    });
  }

  unmount(name, cx) {
    if (this.busy[name]) return;
    this.busy[name] = "unmounting";
    delete this.error[name];
    delete this.hostkey[name];
    cx.notify();
    cx.spawn(async (cx) => { await this.stop(name); delete this.busy[name]; await this.refresh(); cx.notify(); });
  }

  // ctrl+c lets rclone finish uploads and unmount itself. Only if it won't
  // (no terminal, or stuck past 60 s) fall back to umount.
  async stop(name) {
    const mp = this.mountpoint(name);
    if (this.running[name] === "live") {
      await hc(["interrupt", term(name), "--timeout", "5"]).catch(() => null);
      for (let i = 0; i < 120; i++) {
        await this.refresh();
        if (this.running[name] !== "live" && !this.isMounted(name)) break;
        await exec("sleep", ["0.5"]);
      }
    }
    await this.refresh();
    if (this.isMounted(name)) {
      const u = await exec("umount", [mp]).catch((e) => ({ code: 1, stderr: String(e) }));
      if (u.code !== 0) this.error[name] = `Still mounted at ${mp}: ${(u.stderr || "").trim()}. Close what's using it, or \`umount -f ${mp}\`.`;
    }
    if (this.running[name] === "live") await hc(["kill", term(name)]).catch(() => null);
    await hc(["rm", term(name)]).catch(() => null);
  }

  remove(name, cx) {
    if (this.confirmRemove !== name) { this.confirmRemove = name; cx.notify(); return; }
    this.confirmRemove = null;
    this.busy[name] = "removing";
    cx.notify();
    cx.spawn(async (cx) => {
      if (this.isMounted(name) || this.running[name]) await this.stop(name);
      const r = await exec("rclone", ["config", "delete", name]).catch((e) => ({ code: 1, stderr: String(e) }));
      if (r.code !== 0) this.error[name] = (r.stderr || "").trim() || "rclone config delete failed";
      else { delete this.prefs[name]; this.savePrefs(); }
      delete this.busy[name];
      await this.refresh();
      cx.notify();
    });
  }

  test(name, cx) {
    if (this.busy[name]) return;
    this.busy[name] = "testing";
    delete this.error[name];
    delete this.hostkey[name];
    cx.notify();
    cx.spawn(async (cx) => {
      const r = await exec("rclone", ["lsf", `${name}:${this.remotePath(name)}`, "--max-depth", "1", "--contimeout", "10s", "--low-level-retries", "1", "--retries", "1"], { timeout: 30000 })
        .catch((e) => ({ code: 1, stderr: String(e), stdout: "" }));
      if (r.code === 0) notify({ title: `${name} answers`, body: `${r.stdout.split("\n").filter(Boolean).length} entries in ${this.remotePath(name) || "the login folder"}`, level: "success", timeout: 4000 });
      else { this.error[name] = lastLines(r.stderr || r.stdout); await this.checkHostKey(name); }
      delete this.busy[name];
      cx.notify();
    });
  }

  // rclone checks host keys against ~/.ssh/known_hosts. A server not in it
  // fails with "knownhosts: key is unknown": fetch its keys and show their
  // fingerprints so the person can compare them with what the host
  // publishes, then trust them with one click. A *mismatch* is never offered.
  async checkHostKey(name) {
    const err = this.error[name] ?? "";
    if (/knownhosts: key mismatch/i.test(err)) {
      this.error[name] = "The server's host key doesn't match the one in ~/.ssh/known_hosts. It may have been rebuilt, or someone may be intercepting the connection. Check with the host before changing known_hosts.";
      return;
    }
    if (!/knownhosts: key is unknown/i.test(err)) return;
    const r = this.remotes?.find((x) => x.name === name);
    if (!r?.host) return;
    const port = r.port && r.port !== "22" ? r.port : null;
    const host = port ? `[${r.host}]:${port}` : r.host;
    const scan = await exec("ssh-keyscan", [...(port ? ["-p", port] : []), "-T", "10", r.host], { timeout: 20000 }).catch(() => null);
    const lines = (scan?.stdout ?? "").split("\n").filter((l) => l.trim() && !l.startsWith("#"));
    if (!lines.length) { this.error[name] += "\nCouldn't fetch the server's host key (ssh-keyscan got nothing)."; return; }
    const fp = await exec("sh", ["-c", 'printf "%s\\n" "$1" | ssh-keygen -lf -', "sh", lines.join("\n")]).catch(() => null);
    const fingerprints = (fp?.stdout ?? "").split("\n").filter(Boolean).map((l) => {
      const m = l.match(/^\d+\s+(\S+)\s+.*\((\w+)\)\s*$/);
      return m ? `${m[2]}  ${m[1]}` : l;
    });
    this.hostkey[name] = { host, lines, fingerprints };
    this.error[name] = `${host} isn't in ~/.ssh/known_hosts yet.`;
  }

  trustHostKey(name, cx) {
    const k = this.hostkey[name];
    if (!k || k.trusting) return;
    k.trusting = true;
    cx.notify();
    cx.spawn(async (cx) => {
      const file = `${home()}/.ssh/known_hosts`;
      const r = await exec("sh", ["-c", 'd="$(dirname "$2")"; [ -d "$d" ] || { mkdir -p "$d" && chmod 700 "$d"; }; printf "%s\\n" "$1" >> "$2"', "sh", k.lines.join("\n"), file])
        .catch((e) => ({ code: 1, stderr: String(e) }));
      delete this.hostkey[name];
      if (r.code !== 0) { this.error[name] = `Couldn't write ${file}: ${(r.stderr || "").trim()}`; cx.notify(); return; }
      delete this.error[name];
      cx.notify();
      this.test(name, cx);
    });
  }

  hostKeyCard(t, name) {
    const k = this.hostkey[name];
    return v_flex().ml(25).mt(2).p(10).gap(6).rounded(8).bg(t.blocked + "14").border_1().border_color(t.blocked + "40")
      .child(div().text_size(12).text_color(t.muted).line_height("17px")
        .child("Its host key fingerprint is below. Trust it only if it matches what your host publishes (their dashboard or support docs). Once trusted, rclone refuses the server if this key ever changes."))
      .children(k.fingerprints.map((f, i) => div().id(`sm-fp-${name}-${i}`).px(8).py(3).rounded(5).bg(t.background).border_1().border_color(t.border)
        .text_size(11.5).text_color(t.foreground).child(f)))
      .child(h_flex().gap(6).pt(2)
        .child(this.button(t, `sm-trust-${name}`, k.trusting ? "Trusting…" : "Trust host key and test", (cx) => this.trustHostKey(name, cx), { primary: true, disabled: k.trusting }))
        .child(this.button(t, `sm-trust-no-${name}`, "Don't trust", (cx) => { delete this.hostkey[name]; cx.notify(); })));
  }

  openSpace(name) {
    run("space.new", { name: `sftp: ${name}`, folder: this.mountpoint(name) });
    closeOverlay(props().overlay);
  }

  create(cx) {
    const v = Object.fromEntries(Object.entries(this.fields).map(([k, s]) => [k, s.value().trim()]));
    v.pass = this.fields.pass.value(); // keep spaces in passwords
    if (!NAME_OK.test(v.name)) { this.addError = "Name: 1-26 of a-z 0-9 - _"; cx.notify(); return; }
    if (this.remotes?.some((r) => r.name === v.name)) { this.addError = `${v.name} already exists.`; cx.notify(); return; }
    if (!v.host) { this.addError = "Host is needed."; cx.notify(); return; }
    if (v.port && !/^\d+$/.test(v.port)) { this.addError = "Port is a number."; cx.notify(); return; }
    this.addBusy = true;
    this.addError = null;
    cx.notify();
    cx.spawn(async (cx) => {
      const opts = [`host=${v.host}`, `known_hosts_file=${home()}/.ssh/known_hosts`];
      if (v.user) opts.push(`user=${v.user}`);
      if (v.port) opts.push(`port=${v.port}`);
      if (v.key) opts.push(`key_file=${v.key.replace(/^~(?=\/)/, home())}`);
      if (v.pass) opts.push(`pass=${v.pass}`);
      // --obscure: rclone stores the password obscured (not encrypted).
      const r = await exec("rclone", ["config", "create", v.name, "sftp", ...opts, "--obscure", "--non-interactive"])
        .catch((e) => ({ code: 1, stderr: String(e), stdout: "" }));
      this.addBusy = false;
      if (r.code !== 0) { this.addError = lastLines(r.stderr || r.stdout); cx.notify(); return; }
      this.prefs[v.name] = { path: v.path };
      this.savePrefs();
      for (const s of Object.values(this.fields)) s.set_value("");
      this.adding = false;
      await this.refresh();
      this.test(v.name, cx);
    });
  }

  close() { closeOverlay(props().overlay); }

  // UI ---------------------------------------------------------------------

  button(t, id, label, onClick, { primary = false, danger = false, disabled = false } = {}) {
    return div().id(id).h(26).px(10).flex().items_center().rounded(7).text_size(12).font_medium()
      .when(primary, (el) => el.bg(t.solid).text_color(t.solid_foreground).hover((s) => s.opacity(0.88)))
      .when(!primary, (el) => el.border_1().border_color(danger ? t.blocked : t.input).bg(t.raised)
        .text_color(danger ? t.blocked : t.foreground).hover((s) => s.bg(t.hover)))
      .when(disabled, (el) => el.opacity(0.4))
      .when(!disabled, (el) => el.cursor_pointer().on_click((_e, cx) => onClick(cx)))
      .child(label);
  }

  row(t, r) {
    const busy = this.busy[r.name];
    const mounted = this.isMounted(r.name);
    const mp = this.mountpoint(r.name);
    const where = r.ssh ? r.ssh : `${r.user ? r.user + "@" : ""}${r.host}${r.port && r.port !== "22" ? ":" + r.port : ""}`;
    const path = this.remotePath(r.name);
    const status = busy
      ? h_flex().gap(6).items_center().text_size(12).text_color(t.muted)
          .child(svg(I("spinner")).size(12).text_color(t.working).spin(900))
          .child({ mounting: "Mounting", unmounting: "Finishing uploads", removing: "Removing", testing: "Testing" }[busy])
      : mounted
        ? h_flex().gap(5).items_center().text_size(12).text_color(t.ansi2).child(svg(I("circle-check")).size(13)).child("Mounted")
        : div().text_size(12).text_color(t.dim).child("Not mounted");
    const actions = h_flex().gap(6).items_center()
      .when(mounted && !busy, (el) => el
        .child(this.button(t, `sm-open-${r.name}`, "Open space", () => this.openSpace(r.name), { primary: true }))
        .child(this.button(t, `sm-log-${r.name}`, "Log", () => { run("terminal.peek", { terminal: term(r.name) }); this.close(); }))
        .child(this.button(t, `sm-unmount-${r.name}`, "Unmount", (cx) => this.unmount(r.name, cx))))
      .when(!mounted && !busy, (el) => el
        .child(this.button(t, `sm-mount-${r.name}`, "Mount", (cx) => this.mount(r.name, cx), { primary: true }))
        .child(this.button(t, `sm-test-${r.name}`, "Test", (cx) => this.test(r.name, cx)))
        .child(this.button(t, `sm-rm-${r.name}`, this.confirmRemove === r.name ? "Really remove?" : "Remove", (cx) => this.remove(r.name, cx), { danger: this.confirmRemove === r.name })));
    return v_flex().id(`sm-row-${r.name}`).flex_none().px(10).py(8).gap(6).rounded(8).hover((s) => s.bg(t.hover))
      .child(h_flex().gap(10).items_center()
        .child(svg(I("server")).size(15).text_color(t.muted))
        .child(v_flex().flex_1().min_w(0)
          .child(h_flex().gap(8).items_center()
            .child(div().text_size(13).text_color(t.foreground).child(r.name))
            .child(div().min_w(0).truncate().text_size(12).text_color(t.dim).child(`${where}${path ? " " + path : ""}`)))
          .child(div().truncate().text_size(11.5).text_color(t.dim).child(mounted ? mp : `→ ${mp}`)))
        .child(status))
      .child(h_flex().pl(25).child(actions))
      .when(Boolean(this.error[r.name]), (el) => el.child(div().pl(25).text_size(11.5).text_color(t.blocked).child(this.error[r.name])))
      .when(Boolean(this.hostkey[r.name]), (el) => el.child(this.hostKeyCard(t, r.name)));
  }

  field(t, key, w) {
    return Input.new(this.fields[key]).when(w != null, (el) => el.w(w)).when(w == null, (el) => el.flex_1())
      .h(30).px(9).items_center().rounded(7).border_1().border_color(t.input).bg(t.background).text_size(12.5).text_color(t.foreground);
  }

  addForm(t) {
    return v_flex().gap(8).pt(12)
      .child(h_flex().gap(8).child(this.field(t, "name", 170)).child(this.field(t, "user", 130)).child(this.field(t, "host")).child(this.field(t, "port", 64)))
      .child(h_flex().gap(8).child(this.field(t, "key")).child(this.field(t, "pass", 200)))
      .child(h_flex().gap(8).child(this.field(t, "path")))
      .child(div().text_size(11.5).line_height("16px").text_color(t.dim)
        .child("Host keys are checked against ~/.ssh/known_hosts: ssh to a new server once first. A password is stored obscured in rclone.conf, not encrypted; prefer a key or ssh-agent."))
      .when(Boolean(this.addError), (el) => el.child(div().text_size(12).text_color(t.blocked).child(this.addError)))
      .child(h_flex().gap(8).justify_end()
        .child(this.button(t, "sm-add-cancel", "Cancel", (cx) => { this.adding = false; this.addError = null; cx.notify(); }))
        .child(this.button(t, "sm-add-save", this.addBusy ? "Adding…" : "Add and test", (cx) => this.create(cx), { primary: true, disabled: this.addBusy })));
  }

  render() {
    const t = theme();
    const header = h_flex().items_center()
      .child(div().flex_1().text_size(15).font_semibold().child("SFTP mounts"))
      .child(div().id("sm-esc").px(6).py(2).rounded(5).text_size(11).text_color(t.dim).cursor_pointer()
        .hover((s) => s.bg(t.hover).text_color(t.foreground)).on_click(() => this.close()).child("Esc"));
    const intro = div().pt(6).text_size(12.8).line_height("19px").text_color(t.muted)
      .child("Servers that only speak SFTP, mounted as folders so agents edit them like local files. Saves upload as soon as a file closes.");
    let body;
    if (this.rclone === null) body = div().py(10).text_size(12.5).text_color(t.dim).child("Looking for rclone…");
    else if (this.rclone === false) body = v_flex().py(10).gap(8).text_size(12.5).text_color(t.muted)
      .child("rclone isn't installed. Install it, then reopen this:")
      .child(h_flex().gap(8).items_center().child(div().text_color(t.foreground).child("brew install rclone"))
        .child(this.button(t, "sm-install", "Run in a tab", () => { run("tab.new", { argv: ["brew", "install", "rclone"] }); this.close(); })));
    else body = v_flex().pt(14)
      .child(v_flex().id("sm-list").max_h(380).min_h(0).overflow_y_scroll().children(
        this.remotes === null ? [div().px(10).py(8).text_size(12.5).text_color(t.dim).child("Reading rclone.conf…")]
          : this.remotes.length === 0 ? [div().px(10).py(8).text_size(12.5).text_color(t.dim).child("No SFTP remotes yet.")]
          : this.remotes.map((r) => this.row(t, r))))
      .child(this.adding ? this.addForm(t) : h_flex().gap(8).pt(12)
        .child(this.button(t, "sm-add", "Add server", (cx) => { this.adding = true; this.fields.name.focus(); cx.notify(); }, { primary: true }))
        .child(this.button(t, "sm-config", "rclone config…", () => { run("tab.new", { name: "rclone config", argv: ["rclone", "config"] }); this.close(); })));
    return v_flex().id("sftp-mounts").track_focus(this.handle)
      .on_key_down((e, cx) => { if (e.key === "escape") { this.close(); cx.stop_propagation(); } })
      .w_full().min_h(0).p(18).bg(t.popover).text_color(t.foreground)
      .child(header).child(intro).child(body);
  }
}

function lastLines(text, n = 4) {
  return String(text ?? "").split("\n").map((l) => l.replace(/^\d{4}\/\d\d\/\d\d \d\d:\d\d:\d\d /, "").trim()).filter(Boolean).slice(-n).join("\n") || "failed";
}
