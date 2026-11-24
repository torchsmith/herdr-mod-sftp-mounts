// SFTP mounts panel: every active rclone mount, with Open space, Log and
// Unmount. Docks on the right the first time Herdr sees it; it can also be a
// block in a layout's panel stack (`{ "mod": "sftp-panel" }`). Adding and
// removing servers is the `sftp-mounts` dialog's job ("Manage").
//
// A mount is either one the dialog started (a herdr-core terminal named
// `sftp-<remote>` running `rclone nfsmount`), or a stray rclone NFS mount
// (`localhost:/...`) with no terminal, e.g. started by hand. Unmount stops the
// terminal with ctrl+c so rclone finishes uploads first; a stray one gets
// `umount`.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { exec, hc, home, theme, run, layout, window, checking } from "herdr";

const I = (name) => `mods/workspace-chrome/${name}.svg`;
const ME = "sftp-panel";

// Is this mod's block on screen: not hidden, and the chosen child of every
// stack above it. null: not in this subtree.
function shownIn(node) {
  if (!node) return null;
  if (node.content?.mod === ME) return !node.hidden;
  for (const c of node.children ?? []) {
    const r = shownIn(c);
    if (r === null) continue;
    return r && !node.hidden && (node.type !== "stack" || !node.active || node.active === c.id);
  }
  return null;
}

const tilde = (p) => (p.startsWith(home() + "/") ? "~" + p.slice(home().length) : p);

export default class SftpPanel extends View {
  init(_props, cx) {
    this.mounts = null; // [{ key, remote, source, mountpoint, terminal, mounted }]
    this.busy = {};
    this.error = {};
    this.visible = false;
    if (checking()) return;
    cx.timer.every(5000, (cx) => { if (this.visible) this.reload(cx); });
  }

  reload(cx) {
    if (this.loading) return;
    this.loading = true;
    cx.spawn(async (cx) => {
      try { this.mounts = await this.scan(); } finally { this.loading = false; }
      cx.notify();
    });
  }

  async scan() {
    // OS mounts: rclone's NFS server answers as localhost.
    const m = await exec("mount", []).catch(() => null);
    const os = new Map();
    for (const line of (m?.stdout ?? "").split("\n")) {
      const x = line.match(/^(.*?) on (.+) \((nfs|fuse|macfuse|osxfuse)\b/);
      if (x) os.set(x[2], { source: x[1], kind: x[3] });
    }
    // The dialog's terminals.
    const ls = await hc(["ls", "--json"]).catch(() => null);
    let terms = [];
    try { terms = (JSON.parse(ls?.stdout || "{}").terminals ?? []).filter((t) => t.name?.startsWith("sftp-") && t.state === "live"); } catch { terms = []; }
    const out = [];
    for (const t of terms) {
      const g = await hc(["get", t.name, "--json"]).catch(() => null);
      let argv = [];
      try { argv = JSON.parse(g?.stdout || "{}").argv ?? []; } catch { argv = []; }
      const i = argv.findIndex((a) => a === "nfsmount" || a === "mount");
      const source = i >= 0 ? argv[i + 1] : t.name.slice(5) + ":";
      const mountpoint = i >= 0 ? argv[i + 2] : null;
      out.push({ key: t.name, remote: t.name.slice(5), source, mountpoint, terminal: t.name, mounted: mountpoint ? os.has(mountpoint) : false });
      if (mountpoint) os.delete(mountpoint);
    }
    // Strays: rclone NFS mounts nobody here is running.
    for (const [mountpoint, o] of os) {
      if (o.kind !== "nfs" || !/^(localhost|127\.0\.0\.1):/.test(o.source)) continue;
      out.push({ key: mountpoint, remote: mountpoint.split("/").pop(), source: o.source, mountpoint, terminal: null, mounted: true });
    }
    return out.sort((a, b) => a.remote.localeCompare(b.remote));
  }

  unmount(m, cx) {
    if (this.busy[m.key]) return;
    this.busy[m.key] = true;
    delete this.error[m.key];
    cx.notify();
    cx.spawn(async (cx) => {
      const stillMounted = async () => {
        const r = await exec("mount", []).catch(() => null);
        return (r?.stdout ?? "").includes(` on ${m.mountpoint} (`);
      };
      if (m.terminal) {
        await hc(["interrupt", m.terminal, "--timeout", "5"]).catch(() => null);
        // ctrl+c: rclone uploads what's pending, unmounts, exits. Up to 60 s.
        for (let i = 0; i < 120; i++) {
          const g = await hc(["get", m.terminal, "--json"]).catch(() => null);
          let live = false;
          try { live = JSON.parse(g?.stdout || "{}").state === "live"; } catch { live = false; }
          if (!live) break;
          await exec("sleep", ["0.5"]);
        }
      }
      if (m.mountpoint && (await stillMounted())) {
        const u = await exec("umount", [m.mountpoint]).catch((e) => ({ code: 1, stderr: String(e) }));
        if (u.code !== 0) this.error[m.key] = `Busy: ${(u.stderr || "").trim() || "umount failed"}. Close what's using it, or umount -f.`;
      }
      if (m.terminal) {
        await hc(["kill", m.terminal]).catch(() => null);
        await hc(["rm", m.terminal]).catch(() => null);
      }
      delete this.busy[m.key];
      this.mounts = await this.scan();
      cx.notify();
    });
  }

  row(t, m) {
    const busy = this.busy[m.key];
    const btn = (id, label, onClick) => div().id(id).h(22).px(8).flex().items_center().rounded(6)
      .border_1().border_color(t.input).bg(t.raised).text_size(11.5).text_color(t.foreground)
      .cursor_pointer().hover((s) => s.bg(t.hover)).on_click((_e, cx) => onClick(cx)).child(label);
    return v_flex().id(`sp-${m.key}`).flex_none().px(10).py(8).gap(5).rounded(8).hover((s) => s.bg(t.hover))
      .child(h_flex().gap(8).items_center()
        .child(div().size(7).flex_none().rounded(4).bg(m.mounted ? t.ansi2 : t.blocked))
        .child(div().flex_1().min_w(0).truncate().text_size(13).text_color(t.foreground).child(m.remote))
        .when(!m.terminal, (el) => el.child(div().text_size(11).text_color(t.dim).child("not from Herdr"))))
      .child(div().pl(15).truncate().text_size(11.5).text_color(t.dim).child(m.source))
      .when(Boolean(m.mountpoint), (el) => el.child(div().pl(15).truncate().text_size(11.5).text_color(t.muted).child(tilde(m.mountpoint))))
      .when(!m.mounted && !busy, (el) => el.child(div().pl(15).text_size(11.5).text_color(t.blocked).child("rclone is running but not mounted")))
      .child(h_flex().pl(15).pt(2).gap(6).items_center()
        .when(Boolean(busy), (el) => el
          .child(svg(I("spinner")).size(12).text_color(t.working).spin(900))
          .child(div().text_size(11.5).text_color(t.muted).child("Finishing uploads…")))
        .when(!busy, (el) => el
          .when(m.mounted, (el) => el.child(btn(`sp-open-${m.key}`, "Open space", () => run("space.new", { name: `sftp: ${m.remote}`, folder: m.mountpoint }))))
          .when(Boolean(m.terminal), (el) => el.child(btn(`sp-log-${m.key}`, "Log", () => run("terminal.peek", { terminal: m.terminal }))))
          .child(btn(`sp-un-${m.key}`, "Unmount", (cx) => this.unmount(m, cx)))))
      .when(Boolean(this.error[m.key]), (el) => el.child(div().pl(15).text_size(11.5).text_color(t.blocked).child(this.error[m.key])));
  }

  render(cx) {
    const t = theme();
    const visible = Boolean(window()?.visible ?? true) && shownIn(layout()) === true;
    if (visible && !this.visible) this.reload(cx);
    this.visible = visible;
    const header = h_flex().h(34).flex_none().px(12).gap(8).items_center().border_b(1).border_color(t.border)
      .child(div().flex_1().text_size(12.5).font_semibold().text_color(t.foreground).child("SFTP mounts"))
      .child(div().id("sp-refresh").px(6).py(2).rounded(5).text_size(11.5).text_color(t.dim).cursor_pointer()
        .hover((s) => s.bg(t.hover).text_color(t.foreground)).on_click((_e, cx) => this.reload(cx)).child("Refresh"))
      .child(div().id("sp-manage").px(6).py(2).rounded(5).text_size(11.5).text_color(t.dim).cursor_pointer()
        .hover((s) => s.bg(t.hover).text_color(t.foreground)).on_click(() => run("mod.open", { name: "sftp-mounts" })).child("Manage"));
    const list = this.mounts === null
      ? [div().px(12).py(10).text_size(12).text_color(t.dim).child("Looking…")]
      : this.mounts.length === 0
        ? [v_flex().px(12).py(10).gap(8)
            .child(div().text_size(12).text_color(t.dim).child("No active mounts."))
            .child(h_flex().child(div().id("sp-mount").h(24).px(10).flex().items_center().rounded(6).bg(t.solid)
              .text_color(t.solid_foreground).text_size(11.5).font_medium().cursor_pointer().hover((s) => s.opacity(0.88))
              .on_click(() => run("mod.open", { name: "sftp-mounts" })).child("Mount a server…")))]
        : this.mounts.map((m) => this.row(t, m));
    return v_flex().id("sftp-panel").size_full().min_h(0).bg(t.surface).text_color(t.foreground)
      .child(header)
      .child(v_flex().id("sp-list").flex_1().min_h(0).p(4).overflow_y_scroll().children(list));
  }
}
