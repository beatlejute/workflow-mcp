import fs from 'node:fs';
import path from 'node:path';

/**
 * Проверки имени и наличия скила — общие для `list_skill_tests`,
 * `run_skill_tests` и `create_coach_ticket`.
 *
 * Прежде модуль назывался `runner.mjs` и содержал ещё `runSkill` для tool'а
 * `run_skill`. Тот звал `.workflow/src/scripts/run-skill.js`, которого нет ни
 * в workflow-ai, ни в его истории, и потому всегда отвечал
 * `SKILL_RUNNER_UNAVAILABLE`; в 4.0.0 tool удалён вместе с раннером.
 */

/**
 * Skill name validation regex: lowercase, start with letter, max 51 chars total
 */
const SKILL_NAME_REGEX = /^[a-z][a-z0-9-]{0,50}$/;

/**
 * Check if a skill name is valid
 * @param {string} skillName
 * @returns {boolean}
 */
export function isValidSkillName(skillName) {
  return SKILL_NAME_REGEX.test(skillName);
}

/**
 * Check if a skill exists in the project
 * @param {string} projectPath
 * @param {string} skillName
 * @returns {boolean}
 */
export function skillExists(projectPath, skillName) {
  // Standard location: .workflow/src/skills/<skillName>
  const skillDir = path.join(projectPath, '.workflow', 'src', 'skills', skillName);
  return fs.existsSync(skillDir);
}
