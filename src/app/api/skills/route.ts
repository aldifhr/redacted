import { NextResponse } from "next/server";
import { z } from "zod";
import { installSkill, listInstalledSkills, loadInstalledSkillsSync, removeSkill, searchSkills, setSkillDisabled } from "@/lib/skills";
import { guardApi } from "@/lib/api-guard";


export async function GET(request: Request) {
  const blocked = guardApi(request, { scope: "skills" });
  if (blocked) return blocked;
  try {
    const query = new URL(request.url).searchParams.get("q") ?? "";
    return NextResponse.json({
      skills: await searchSkills(query),
      installed: await listInstalledSkills(),
      available: loadInstalledSkillsSync().map((s) => s.id),
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Failed to load skills" }, { status: 502 });
  }
}

export async function POST(request: Request) {
  const blocked = guardApi(request, { scope: "skills" });
  if (blocked) return blocked;
  const parsed = z.object({
    action: z.enum(["install", "remove", "disable", "enable"]).optional(),
    id: z.string().min(1).max(200),
  }).safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "skill id is required" }, { status: 400 });
  }
  try {
    const body = parsed.data;
    if (body.action === "remove") return NextResponse.json(await removeSkill(body.id));
    if (body.action === "disable") return NextResponse.json(await setSkillDisabled(body.id, true));
    if (body.action === "enable") return NextResponse.json(await setSkillDisabled(body.id, false));
    return NextResponse.json(await installSkill(body.id));
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Failed to install skill" }, { status: 400 });
  }
}
