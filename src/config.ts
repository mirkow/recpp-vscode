import * as vscode from 'vscode';
import * as fs from 'fs';

export function isWorkspaceOpened() {
	return vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0;
}

export function getWorkspaceFolder(): string {
	if (!vscode.workspace.workspaceFolders || vscode.workspace.workspaceFolders.length == 0) {
		{
			throw Error('This extension needs an opened workspace folder');
		}
	}
	return vscode.workspace.workspaceFolders![0].uri.fsPath;
}

export function getBuildDir(): string {
	var buildDir: string = vscode.workspace.getConfiguration('recpp').get('buildDir') || '';
	if (buildDir.length == 0) {
		const err = 'buildDir is not configured';
		throw new Error(err);
	}

	const workspaceFolder = getWorkspaceFolder();
	buildDir = buildDir.replace('${workspaceFolder}', workspaceFolder);
	if (!fs.existsSync(buildDir)) {
		const err = `'${buildDir}' does not exist`;
		throw new Error(err);
	}
	return buildDir;
}

export function getClangdPath(): string {
	const clangdPath: string =
		vscode.workspace.getConfiguration('recpp').get('clangdPath') || '';
	if (clangdPath.length == 0) {
		const err = 'clangdPath is not configured!';
		throw new Error(err);
	}
	if (!fs.existsSync(clangdPath!)) {
		const err = `'${clangdPath}' does not exist`;
		throw new Error(err);
	}
	return clangdPath;
}

export function getRecppPath(): string {
	const recppPath: string =
		vscode.workspace.getConfiguration('recpp').get('recppPath') || '';
	if (recppPath.length == 0) {
		const err = 'recppPath is not configured';
		throw new Error(err);
	}
	if (!fs.existsSync(recppPath)) {
		const err = `'${recppPath}' does not exist`;
		throw new Error(err);
	}
	return recppPath;
}

export function getClangExtraArgs(): string[] {
	const extraArgs: string[] =
		vscode.workspace.getConfiguration('recpp').get('clangExtraArgs') || [];
	return extraArgs;
}

export function getExtraArgs(): string[] {
	const extraArgs: string[] =
		vscode.workspace.getConfiguration('recpp').get('extraArgs') || [];
	return extraArgs;
}
