import { list_ghost_executions } from './src/tools/diagnostics.mjs';
import fs from 'fs';
import path from 'path';

async function debugTest() {
  // Set test directory
  process.env.MCP_CWD = '/tmp/debug-test';
  
  const testDir = '/tmp/debug-test';
  const logsDir = path.join(testDir, '.workflow', 'logs');
  
  // Create directories
  fs.mkdirSync(path.join(testDir, '.workflow'), { recursive: true });
  fs.mkdirSync(logsDir, { recursive: true });
  
  // Create config
  fs.writeFileSync(path.join(testDir, '.workflow', 'config.yaml'), 'health:\n  ghost_execution_log_marker: "ghost-execution"\n');
  
  // Create old log
  const oldLogContent = `[2026-04-27 18:00:00] [INFO] [PipelineRunner] Step 1\n[PipelineRunner] Current stage: build\n[PipelineRunner] START stage="build" agent="builder"\nContext:\nticket_id: IMPL-1\n[PipelineRunner] Step 1 output\nghost-execution\n[PipelineRunner] COMPLETE stage="build" status="success" exitCode=0`;
  const oldLogPath = path.join(logsDir, 'pipeline_old.log');
  fs.writeFileSync(oldLogPath, oldLogContent, 'utf8');
  
  // Set old log mtime
  const oldMtime = new Date('2026-04-27T18:30:00Z').getTime();
  fs.utimesSync(oldLogPath, oldMtime / 1000, oldMtime / 1000);
  
  // Create new log
  const newLogContent = `[2026-04-27 19:00:00] [INFO] [PipelineRunner] Step 1\n[PipelineRunner] Current stage: build\n[PipelineRunner] START stage="build" agent="builder"\nContext:\nticket_id: IMPL-1\n[PipelineRunner] Step 1 output\nghost-execution\n[PipelineRunner] COMPLETE stage="build" status="success" exitCode=0`;
  const newLogPath = path.join(logsDir, 'pipeline_new.log');
  fs.writeFileSync(newLogPath, newLogContent, 'utf8');
  
  // Set new log mtime to be after the old log
  const newMtime = new Date('2026-04-27T19:30:00Z').getTime();
  fs.utimesSync(newLogPath, newMtime / 1000, newMtime / 1000);
  
  // Check file mtimes and sort order
  const oldStat = fs.statSync(oldLogPath);
  const newStat = fs.statSync(newLogPath);
  console.log('Old log mtime:', oldStat.mtime, 'type:', typeof oldStat.mtime);
  console.log('New log mtime:', newStat.mtime, 'type:', typeof newStat.mtime);
  console.log('Since date:', new Date('2026-04-27T19:00:00Z'), 'type:', typeof new Date('2026-04-27T19:00:00Z'));
  console.log('Comparison - old < since:', oldStat.mtime < new Date('2026-04-27T19:00:00Z'));
  console.log('Comparison - new < since:', newStat.mtime < new Date('2026-04-27T19:00:00Z'));
  
  // Check sort order
  const logFiles = [
    { path: oldLogPath, name: 'pipeline_old.log', mtime: oldStat.mtime },
    { path: newLogPath, name: 'pipeline_new.log', mtime: newStat.mtime }
  ].sort((a, b) => b.mtime - a.mtime);
  console.log('Sorted log files:', logFiles.map(f => ({ name: f.name, mtime: f.mtime })));
  
  // Test without since filter
  console.log('Testing without since filter...');
  const result1 = await list_ghost_executions.execute({});
  const data1 = JSON.parse(result1.content[0].text);
  console.log('Count without filter:', data1.count);
  
  // Test with since filter
  console.log('Testing with since filter...');
  const result2 = await list_ghost_executions.execute({ 
    since: '2026-04-27T19:00:00Z' 
  });
  const data2 = JSON.parse(result2.content[0].text);
  console.log('Count with since filter:', data2.count);
  console.log('Executions:', data2.executions.map(e => ({ project: e.project, run_id: e.run_id, detected_at: e.detected_at })));
  
  // Clean up
  fs.rmSync(testDir, { recursive: true, force: true });
}

debugTest().catch(console.error);