// The overwatch agent (plan: Overwatch): the one agent that talks with the person, as a live
// global session (globals.ts) that answers from the state files and acts through the
// `factory` CLI. `factory overwatch`, from any factory, starts it or finds the live one.
import { withSkillsLine } from "./skills.ts";
import type { Run } from "./runner.ts";
import { loadAgent, neighbourMap } from "./agents.ts";
import { loadPrompt, render } from "./prompts.ts";
import { allRepos, factoriesOf, factoryHome, factoryLine, liveSession, startSession, type FactoryInfo } from "./globals.ts";

export function overwatchBrief(o: { home: string; factories: FactoryInfo[]; prompt?: string | null; neighbours?: string }) {
  return render(loadPrompt(null, "overwatch"), { // a factory agent: no repo's prompts/ apply
    neighbours: o.neighbours ?? neighbourMap(allRepos(o.factories), null),
    "agent.prompt": o.prompt ?? loadAgent(null, "overwatch")?.prompt ?? "",
    home: o.home,
    factories: o.factories.length ? o.factories.map(factoryLine).join("\n") : "- none yet: factory init makes one",
  });
}

// The live Overwatch's terminal, or null: notes for it are typed there (ask.ts).
export const liveOverwatch = (run: Run, home = factoryHome()) => liveSession(run, "overwatch", home);

export function overwatch(o: { run: Run; now: string; home?: string; factories?: FactoryInfo[] }) {
  const home = o.home ?? factoryHome();
  const known = liveOverwatch(o.run, home);
  if (known) return { terminal: known, started: false };
  const factories = o.factories ?? factoriesOf(home);
  const agent = loadAgent(null, "overwatch");
  return startSession({ run: o.run, now: o.now, agent: "overwatch", home, factories, brief: overwatchBrief({ home, factories, prompt: withSkillsLine(agent?.prompt, agent) }) });
}
