import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dir = path.dirname(fileURLToPath(import.meta.url));

// Path guard (serve.mjs:394-399 pattern): resolved path must stay within base.
function safeResolve(base, ...parts) {
  const resolved = path.resolve(base, ...parts);
  const rel = path.relative(base, resolved);
  if (rel.startsWith("..")) return null;
  return resolved;
}

// Extract the `description` field from YAML frontmatter between --- markers.
// Handles single-line and literal-block (|) multi-line descriptions.
function readFrontmatterDescription(filePath) {
  try {
    const content = fs.readFileSync(filePath, "utf8");
    const fmMatch = content.match(/^---[^\n]*\n([\s\S]*?)\n---/);
    if (!fmMatch) return "";
    const fm = fmMatch[1];
    const descLineMatch = fm.match(/^description:\s*(.*)$/m);
    if (!descLineMatch) return "";
    let desc = descLineMatch[1].trim();
    if (desc === "|" || desc === ">") {
      const fmLines = fm.split("\n");
      const startIdx = fmLines.findIndex((l) => l.startsWith("description:"));
      if (startIdx < 0) return "";
      const descLines = [];
      for (let i = startIdx + 1; i < fmLines.length; i++) {
        const line = fmLines[i];
        if (line.startsWith(" ") || line.startsWith("\t")) {
          descLines.push(line.trimStart());
        } else if (line.trim() === "") {
          descLines.push("");
        } else {
          break;
        }
      }
      return descLines.join(" ").replace(/\s+/g, " ").trim();
    }
    if (!desc) return "";
    if (
      (desc.startsWith('"') && desc.endsWith('"')) ||
      (desc.startsWith("'") && desc.endsWith("'"))
    ) {
      desc = desc.slice(1, -1);
    }
    return desc;
  } catch {
    return "";
  }
}

// Scan a directory for *.md files, returning { name, description } for each.
function scanMd(base, ...subdirs) {
  const items = [];
  const dir = safeResolve(base, ...subdirs);
  if (!dir) return items;
  try {
    const stat = fs.statSync(dir);
    if (!stat.isDirectory()) return items;
    for (const entry of fs.readdirSync(dir)) {
      if (!entry.endsWith(".md")) continue;
      const filePath = path.join(dir, entry);
      const desc = readFrontmatterDescription(filePath);
      items.push({ name: entry.slice(0, -".md".length), description: desc });
    }
  } catch {
    // degrade to empty list on any error
  }
  return items;
}

// Scan a directory of skill subdirectories for SKILL.md files.
function scanSkills(base, ...subdirs) {
  const items = [];
  const dir = safeResolve(base, ...subdirs);
  if (!dir) return items;
  try {
    const stat = fs.statSync(dir);
    if (!stat.isDirectory()) return items;
    for (const entry of fs.readdirSync(dir)) {
      const skillDir = path.join(dir, entry);
      const skillFile = path.join(skillDir, "SKILL.md");
      try {
        const fileStat = fs.statSync(skillFile);
        if (!fileStat.isFile()) continue;
      } catch {
        continue;
      }
      const desc = readFrontmatterDescription(skillFile);
      items.push({ name: entry, description: desc });
    }
  } catch {
    // degrade to empty list on any error
  }
  return items;
}

// Aggregate tool call counts from state.json details[].tools.byType.
function gatherTools(statePath) {
  const tools = {};
  try {
    const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
    for (const d of state.details || []) {
      const byType = d.tools && d.tools.byType;
      if (!byType) continue;
      for (const [name, count] of Object.entries(byType)) {
        tools[name] = (tools[name] || 0) + count;
      }
    }
  } catch {
    // degrade to empty object on any error
  }
  return tools;
}

export function catalog(statePath) {
  const projectDir = path.dirname(statePath);
  const globalAgent = safeResolve(process.env.USERPROFILE || "", ".config", "kilo", "agent");
  const globalCommand = safeResolve(process.env.USERPROFILE || "", ".config", "kilo", "command");
  const globalSkills = safeResolve(process.env.USERPROFILE || "", ".agents", "skills");

  return {
    agents: [...scanMd(projectDir, ".kilo", "agent"), ...(globalAgent ? scanMd(globalAgent) : [])],
    commands: [
      ...scanMd(projectDir, ".kilo", "command"),
      ...(globalCommand ? scanMd(globalCommand) : []),
    ],
    skills: [...scanSkills(globalSkills), ...scanMd(projectDir, ".kilo", "skills")],
    tools: gatherTools(statePath),
  };
}
