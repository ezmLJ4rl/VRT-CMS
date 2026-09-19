'use strict';

// Special Project money is a normal offering ledger row with a project_id.
// These rules are shared by manual desk entry and imported-payment reconciliation
// so the two paths cannot disagree about what is allowed to fund a project.
const PROJECT_CONTRIBUTION_STATUSES = new Set(['active']);

function projectContributionError(project, categoryKey) {
  if (categoryKey !== 'special') return 'errors.projectOnlySpecialCategory';
  if (!project) return 'errors.projectNotFound';
  if (!PROJECT_CONTRIBUTION_STATUSES.has(project.status)) return 'errors.projectNotAcceptingContributions';
  return null;
}

module.exports = { PROJECT_CONTRIBUTION_STATUSES, projectContributionError };
