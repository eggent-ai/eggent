import { learningAvailable, learningEnabled } from "@/lib/learning/config";
import { learnedView } from "@/lib/learning/notes";
import { learnedSkillsView } from "@/lib/learning/usage";
import type { LearningView } from "@/lib/learning/types";

/** Everything the settings page shows about what the agent has learned. */
export async function readLearningView(): Promise<LearningView> {
  const [notes, skills, enabled] = await Promise.all([learnedView(), learnedSkillsView(), learningEnabled()]);
  return {
    available: learningAvailable(),
    enabled: learningAvailable() && enabled,
    notes,
    skills: skills.skills,
    archived: skills.archived,
  };
}
