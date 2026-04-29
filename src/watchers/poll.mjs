export function pollDirectory(directoryPath, interval, onChange) {
  const fs = require('fs');

  let previousState = new Map();

  const scanDirectory = () => {
    try {
      const files = fs.readdirSync(directoryPath);
      const currentState = new Map();

      for (const file of files) {
        const filePath = `${directoryPath}/${file}`;
        try {
          const stats = fs.statSync(filePath);
          currentState.set(file, stats.mtimeMs);
        } catch (err) {
          // File might have been deleted between readdir and stat
          continue;
        }
      }

      const added = [];
      const removed = [];
      const modified = [];

      // Check for added and modified
      for (const [file, mtime] of currentState) {
        if (!previousState.has(file)) {
          added.push(file);
        } else if (previousState.get(file) !== mtime) {
          modified.push(file);
        }
      }

      // Check for removed
      for (const [file] of previousState) {
        if (!currentState.has(file)) {
          removed.push(file);
        }
      }

      if (added.length > 0 || removed.length > 0 || modified.length > 0) {
        onChange({ added, removed, modified });
      }

      previousState = currentState;
    } catch (err) {
      console.error(`Error polling directory ${directoryPath}:`, err.message);
    }
  };

  const intervalId = setInterval(scanDirectory, interval);
  scanDirectory(); // Initial scan

  return () => {
    clearInterval(intervalId);
  };
}