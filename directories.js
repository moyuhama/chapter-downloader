import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const run = promisify(execFile);
export const defaultDownloadDirectory = path.join(os.homedir(), 'Downloads');
export async function chooseDirectory() {
  const options = { timeout: 180000, maxBuffer: 65536 };
  try {
    let result;
    if (process.platform === 'darwin') {
      result = await run('osascript', ['-e', 'POSIX path of (choose folder with prompt "选择图片文件夹或保存目录")'], options);
    } else if (process.platform === 'win32') {
      result = await run('powershell.exe', ['-NoProfile', '-STA', '-Command', "Add-Type -AssemblyName System.Windows.Forms; $dialog = New-Object System.Windows.Forms.FolderBrowserDialog; $dialog.Description = '选择图片文件夹或保存目录'; if ($dialog.ShowDialog() -eq 'OK') { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8; Write-Output $dialog.SelectedPath }"], options);
    } else {
      result = await run('zenity', ['--file-selection', '--directory', '--title=选择图片文件夹或保存目录'], options);
    }
    return result.stdout.trim() || null;
  } catch (e) {
    if ((process.platform !== 'darwin' && e.code === 1) || /\(-128\)/.test(e.stderr || '')) return null;
    throw new Error('无法打开文件夹选择窗口，请直接输入完整的保存目录路径');
  }
}
