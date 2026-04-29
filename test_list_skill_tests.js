import { list_skill_tests } from './src/tools/coach.mjs';

// Test 1: List tests for all skills
console.log('Test 1: Listing tests for all skills');
list_skill_tests.execute({
  project: '.'
}).then(result => {
  console.log('Exit code:', result.exit_code);
  console.log('Stdout:', result.stdout);
  console.log('Stderr:', result.stderr);
  console.log('---');

  // Test 2: List tests for specific skill
  console.log('Test 2: Listing tests for test-skill');
  return list_skill_tests.execute({
    project: '.',
    skill_name: 'test-skill'
  });
}).then(result => {
  console.log('Exit code:', result.exit_code);
  console.log('Stdout:', result.stdout);
  console.log('Stderr:', result.stderr);
  console.log('---');

  // Test 3: List tests for non-existent skill
  console.log('Test 3: Listing tests for non-existent skill');
  return list_skill_tests.execute({
    project: '.',
    skill_name: 'non-existent-skill'
  });
}).then(result => {
  console.log('Exit code:', result.exit_code);
  console.log('Stdout:', result.stdout);
  console.log('Stderr:', result.stderr);
  console.log('---');
}).catch(err => {
  console.error('Error:', err);
});