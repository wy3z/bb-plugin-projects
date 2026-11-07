import { createElement, useEffect } from "react";
import { experimental_Icon as Icon, experimental_useRpcQuery } from "@get-bb/plugin-sdk/app";
import {
  AtomIcon,
  BookOpenIcon,
  BracketsIcon,
  BriefcaseIcon,
  BrushIcon,
  CameraIcon,
  ChartLineIcon,
  ChatIcon,
  ChipIcon,
  CloudCogIcon,
  DatabaseIcon,
  FileStackIcon,
  FlagIcon,
  FlaskConicalIcon,
  FolderCodeIcon,
  GamepadIcon,
  HeartIcon,
  ImageIcon,
  LibraryIcon,
  MagicWandIcon,
  MegaphoneIcon,
  MicroscopeIcon,
  MonitorIcon,
  MoonIcon,
  MusicIcon,
  PackageIcon,
  RocketIcon,
  ServerIcon,
  ShieldIcon,
  ShoppingBagIcon,
  SmileIcon,
  SparkleIcon,
  TableIcon,
  WrenchIcon,
} from "@hugeicons/core-free-icons";
import { z } from "zod";
import { ProjectGlyph } from "./glyphs";

export const CURSOR_SIDEBAR_PLUGIN = "cursor-sidebar";
const REFRESH_MS = 60_000;

export const cursorSidebarIconsContract = {
  listProjectIcons: {
    input: z.object({}),
    output: z.object({ icons: z.array(z.object({ projectId: z.string(), icon: z.string() }).passthrough()) }).passthrough(),
  },
};

const COLORS = new Set(["gray", "red", "orange", "amber", "yellow", "lime", "green", "emerald", "teal", "cyan", "sky", "blue", "indigo", "violet", "purple", "fuchsia", "pink", "rose"]);

type HugeShape = readonly [string, Readonly<Record<string, string | number>>];

const OWN_GLYPHS: Readonly<Record<string, readonly HugeShape[]>> = {
  Brackets: BracketsIcon,
  Chip: ChipIcon,
  FolderCode: FolderCodeIcon,
  FileStack: FileStackIcon,
  BookOpen: BookOpenIcon,
  Library: LibraryIcon,
  CloudCog: CloudCogIcon,
  Server: ServerIcon,
  Database: DatabaseIcon,
  Shield: ShieldIcon,
  Rocket: RocketIcon,
  ChartLine: ChartLineIcon,
  Table: TableIcon,
  Atom: AtomIcon,
  FlaskConical: FlaskConicalIcon,
  Microscope: MicroscopeIcon,
  Package: PackageIcon,
  Brush: BrushIcon,
  Camera: CameraIcon,
  Image: ImageIcon,
  Music: MusicIcon,
  MagicWand: MagicWandIcon,
  Gamepad: GamepadIcon,
  Briefcase: BriefcaseIcon,
  ShoppingBag: ShoppingBagIcon,
  Megaphone: MegaphoneIcon,
  Chat: ChatIcon,
  Wrench: WrenchIcon,
  Monitor: MonitorIcon,
  Flag: FlagIcon,
  Sparkle: SparkleIcon,
  Heart: HeartIcon,
  Moon: MoonIcon,
  Smile: SmileIcon,
};

const HOST_GLYPHS: ReadonlySet<string> = new Set(["Code", "Terminal", "Bug", "GitBranch", "Folder", "FileText", "Globe", "Browser", "ExternalLink", "Cloud", "SecurityCheck", "Zap", "ChartColumn", "Beaker", "Brain", "Bot", "Workflow", "Layers", "Palette", "Calendar", "ListTodo", "GridView", "Mail", "Sent", "Smartphone", "Target", "Star"]);

export type ProjectIcon =
  | { kind: "glyph"; name: string; color: string | null }
  | { kind: "emoji"; emoji: string }
  | { kind: "monogram"; text: string; color: string }
  | { kind: "image"; src: string };

const isGlyph = (name: string) => HOST_GLYPHS.has(name) || name in OWN_GLYPHS;

export function parseProjectIcon(stored: string): ProjectIcon | null {
  if (/^data:image\/png;base64,[A-Za-z0-9+/]+=*$/.test(stored)) return { kind: "image", src: stored };
  const colored = (rest: string) => {
    const at = rest.lastIndexOf(":");
    return at === -1 ? null : { value: rest.slice(0, at), color: rest.slice(at + 1) };
  };
  if (stored.startsWith("glyph:")) {
    const parts = colored(stored.slice(6));
    return parts && isGlyph(parts.value) && COLORS.has(parts.color) ? { kind: "glyph", name: parts.value, color: parts.color } : null;
  }
  if (stored.startsWith("emoji:")) {
    const emoji = stored.slice(6);
    return emoji.length > 0 && emoji.length <= 32 ? { kind: "emoji", emoji } : null;
  }
  if (stored.startsWith("monogram:")) {
    const parts = colored(stored.slice(9));
    return parts && parts.value.length > 0 && parts.value.length <= 8 && COLORS.has(parts.color) ? { kind: "monogram", text: parts.value, color: parts.color } : null;
  }
  return isGlyph(stored) ? { kind: "glyph", name: stored, color: null } : null;
}

export function useProjectIcon(bbProjectId: string | null): ProjectIcon | null {
  const query = experimental_useRpcQuery({
    contract: cursorSidebarIconsContract,
    pluginId: CURSOR_SIDEBAR_PLUGIN,
    method: "listProjectIcons",
    input: {},
    enabled: bbProjectId !== null,
  });
  const { refetch } = query;
  const failed = Boolean(query.error) && !query.data;
  useEffect(() => {
    if (bbProjectId === null || failed) return;
    const again = () => {
      if (document.visibilityState === "visible") void refetch().catch(() => undefined);
    };
    const timer = window.setInterval(again, REFRESH_MS);
    window.addEventListener("focus", again);
    document.addEventListener("visibilitychange", again);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", again);
      document.removeEventListener("visibilitychange", again);
    };
  }, [bbProjectId, failed, refetch]);
  if (bbProjectId === null) return null;
  const stored = query.data?.icons.find((row) => row.projectId === bbProjectId)?.icon;
  return stored === undefined ? null : parseProjectIcon(stored);
}

function OwnGlyph({ shapes }: { shapes: readonly HugeShape[] }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false">
      {shapes.map(([tag, attrs], index) => {
        const { key: _key, ...rest } = attrs as Record<string, string | number>;
        return createElement(tag, { ...rest, key: index, ...("strokeWidth" in rest ? { strokeWidth: 2 } : {}) });
      })}
    </svg>
  );
}

export function ProjectIconMark({ icon }: { icon: ProjectIcon | null }) {
  if (icon === null) {
    return (
      <span className="bbp-toolbar__icon" aria-hidden="true">
        <ProjectGlyph />
      </span>
    );
  }
  if (icon.kind === "image") {
    return (
      <span className="bbp-toolbar__icon" data-kind="image" aria-hidden="true">
        <img src={icon.src} alt="" draggable={false} />
      </span>
    );
  }
  if (icon.kind === "emoji") {
    return (
      <span className="bbp-toolbar__icon" data-kind="emoji" aria-hidden="true">
        <span className="bbp-toolbar__emoji">{icon.emoji}</span>
      </span>
    );
  }
  if (icon.kind === "monogram") {
    return (
      <span className={`bbp-toolbar__icon bbp-pi-${icon.color}`} data-kind="monogram" aria-hidden="true">
        <span className="bbp-toolbar__monogram">{icon.text}</span>
      </span>
    );
  }
  const own = OWN_GLYPHS[icon.name];
  return (
    <span className={`bbp-toolbar__icon${icon.color ? ` bbp-pi-${icon.color}` : ""}`} data-kind="glyph" data-plain={icon.color ? undefined : ""} aria-hidden="true">
      {own ? <OwnGlyph shapes={own} /> : <Icon name={icon.name} />}
    </span>
  );
}
