import { execSync } from 'node:child_process';

/**
 * Detects if current branch is diverged from remote tracking branch
 * @param {string} projectPath - Path to project directory
 * @param {Object} config - MCP health configuration
 * @returns {Object|null} Alert object if branch is diverged, null otherwise
 */
export function detectBranchDiverged(projectPath, config) {
  // Check if config has auto_fetch override
  const autoFetch = config.branch_diverged_auto_fetch ?? false;
  
  // Prepare git command arguments
  let gitArgs = ['status', '-sb'];
  if (autoFetch) {
    // Add fetch before status if auto_fetch is true
    try {
      execSync('git fetch --no-write-fetch-head', { 
        cwd: projectPath, 
        stdio: 'ignore' 
      });
    } catch (err) {
      // If fetch fails, continue with status anyway (non-fatal)
    }
  } else {
    // Add --no-fetch to prevent automatic fetch
    gitArgs.push('--no-fetch');
  }
  
  try {
    // Execute git status
    const output = execSync(`git ${gitArgs.join(' ')}`, { 
      cwd: projectPath, 
      encoding: 'utf8'
    });
    
    // Parse output to find current branch line
    const lines = output.trim().split('\n');
    let branchLine = null;
    
    for (const line of lines) {
      if (line.startsWith('## ')) {
        branchLine = line.substring(3); // Remove '## ' prefix
        break;
      }
    }
    
    if (!branchLine) {
      // Not a git repository or no branch info
      return null;
    }
    
    // Parse branch line format: "main...origin/main [ahead 5, behind 3]"
    // or "main" (no tracking branch)
    const match = branchLine.match(/^([^\s]+?)(?:\.\.\.([^\s\[]+))?(?:\s+\[(.*)\])?$/);
    
    if (!match) {
      return null;
    }
    
    const localBranch = match[1];
    const remoteBranch = match[2];
    const statusInfo = match[3] || '';
    
    // If no tracking branch, return null (no divergence possible)
    if (!remoteBranch) {
      return null;
    }
    
    // Parse ahead/behind values from status info
    let ahead = 0;
    let behind = 0;
    
    const aheadMatch = statusInfo.match(/ahead\s+(\d+)/);
    if (aheadMatch) {
      ahead = parseInt(aheadMatch[1], 10);
    }
    
    const behindMatch = statusInfo.match(/behind\s+(\d+)/);
    if (behindMatch) {
      behind = parseInt(behindMatch[1], 10);
    }
    
    // Get thresholds from config with defaults
    const maxBehind = config.branch_diverged_max_behind ?? 10;
    const maxAhead = config.branch_diverged_max_ahead ?? 30;
    
    // Check if divergence exceeds thresholds
    if (behind > maxBehind || ahead > maxAhead) {
      // Create fingerprint for deduplication
      // Extract project name from path (last directory name)
      const projectName = projectPath.split(/[\\/]/).pop() || 'unknown';
      const fingerprint = `branch_diverged:${projectName}:${localBranch}`;
      
      return {
        type: 'branch_diverged',
        severity: 'warning',
        message: `Branch '${localBranch}' has diverged from tracking branch '${remoteBranch}' (ahead ${ahead}, behind ${behind})`,
        fingerprint,
        suggested_actions: ['git_status', 'git_create_branch'],
        data: {
          local_branch: localBranch,
          remote_branch: remoteBranch,
          ahead_count: ahead,
          behind_count: behind,
          max_behind: maxBehind,
          max_ahead: maxAhead
        }
      };
    }
    
    return null;
  } catch (err) {
    // If git command fails (not a git repo, etc.), return null
    if (err.message && err.message.includes('not a git repository')) {
      return null;
    }
    // For other errors, we could log but still return null to avoid false alerts
    return null;
  }
}