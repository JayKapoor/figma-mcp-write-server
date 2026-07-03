import { createServer } from 'http';
import { exec } from 'child_process';
import { promisify } from 'util';
import { logger } from "../utils/logger.js"

const execAsync = promisify(exec);

export async function checkPortAvailable(port: number): Promise<boolean> {
  return Promise.race([
    new Promise<boolean>((resolve) => {
      const testServer = createServer();
      testServer.listen(port, () => {
        testServer.close(() => resolve(true));
      });
      testServer.on('error', () => resolve(false));
    }),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 5000))
  ]);
}

export async function findZombieProcesses(port: number): Promise<string[]> {
  try {
    const { stdout } = await execAsync(`lsof -ti :${port}`);
    return stdout.trim().split('\n').filter(pid => pid);
  } catch (error) {
    // No processes found on port (which is good)
    return [];
  }
}

export async function killZombieProcesses(pids: string[]): Promise<void> {
  for (const pid of pids) {
    try {
      logger.log(`🧟 Killing zombie process ${pid}`);
      await execAsync(`kill -9 ${pid}`);
      // Wait a bit for process to actually die
      await new Promise(resolve => setTimeout(resolve, 500));
    } catch (error) {
      logger.warn(`⚙️ Could not kill process ${pid}:`, error);
    }
  }
}

export async function findAvailablePort(startPort: number, maxTries: number = 10): Promise<number> {
  for (let port = startPort; port < startPort + maxTries; port++) {
    if (await checkPortAvailable(port)) {
      return port;
    }
  }
  throw new Error(`No available ports found in range ${startPort}-${startPort + maxTries - 1}`);
}