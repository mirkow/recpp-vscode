/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import * as fs from 'fs';
import * as URL from 'url-parse';
import {
	POINT_CONVERSION_COMPRESSED,
	SSL_OP_EPHEMERAL_RSA,
	WSAECONNABORTED,
} from 'constants';
import * as vscode from 'vscode';
import * as vscodelc from 'vscode-languageclient/node';
import * as child from 'child_process';

import { lstat } from 'fs';
import { CodeAction } from 'vscode';
import * as cfg from './config';
import * as utils from './utils';
import { Disposable } from 'vscode';
import { constants } from 'os';
import { Writable } from 'stream';
var lineColumn = require('line-column');

const recppCommand = 'recpp.ExecuteRecpp';

function assert(condition: boolean, message: string | undefined = undefined) {
	if (!condition) {
		throw new Error(message || 'Assertion failed');
	}
}
class CppRefactorClient extends vscodelc.LanguageClient {
	handleFailedRequest<T>(type: vscodelc.MessageSignature, error: any, defaultValue: T): T {
		if (
			error instanceof vscodelc.ResponseError &&
			type.method === 'workspace/executeCommand'
		)
			vscode.window.showErrorMessage(error.message);

		return super.handleFailedRequest(type, error, defaultValue);
	}
}

interface SemanticToken {
	line: number;
	start: number;
	length: number;
	tokenType: string;
	tokenModifier: string;
}

interface SemanticSourceToken {
	semanticToken: SemanticToken;
	sourceString: string;
}

class CppSymbolIndex {
	index = new Map();
	semanticTokensLegend: vscodelc.SemanticTokensLegend = {
		tokenModifiers: [],
		tokenTypes: [],
	};
	constructor(tokenTypes: string[], tokenModifiers: string[]) {
		this.semanticTokensLegend = { tokenModifiers: tokenModifiers, tokenTypes: tokenTypes };
	}
	upsert(document: vscode.TextDocument, data: number[]) {
		this.index.set(document.uri.toString(), {
			documentVersion: document.version,
			document: document,
			tokenData: this.parseSemanticTokenArray(data),
			lines: document.getText().split('\n'),
		});
	}
	getSymbolType(uri: string, line: number, column: number): string {
		var symbolType: string = '';
		const data = this.index.get(uri);
		const tokens: SemanticToken[] = data.tokenData;
		for (var i = 0; i < tokens.length; i++) {
			const token = tokens[i];
			if (
				token.line == line &&
				column >= token.start &&
				column <= token.start + token.length
			) {
				symbolType =
					token.tokenType +
					(token.tokenModifier.length > 0 ? '.' + token.tokenModifier : '');
				break;
			}
		}

		return symbolType;
	}
	parseSemanticTokenArray(data: number[]): SemanticToken[] {
		var tokens: SemanticToken[] = [];
		var line = 0;
		var start = 0;
		for (var i = 0; i < data.length - 4; ) {
			assert(i + 4 < data.length);
			const deltaLine = data[i++];
			line = deltaLine + line;
			start = data[i++] + (deltaLine == 0 ? start : 0);
			const length = data[i++];
			const tokenTypeIndex = data[i++];
			const tokenModifiersIndex = data[i++];
			tokens.push({
				line: line,
				start: start,
				length: length,
				tokenType: this.semanticTokensLegend.tokenTypes[tokenTypeIndex] || '',
				tokenModifier: '', // TODO: transform tokenmodifier bitmask
			});
		}
		return tokens;
	}

	static getSourceForSemanticToken(
		sourceLines: string[],
		semanticToken: SemanticToken
	): SemanticSourceToken {
		return {
			semanticToken: semanticToken,
			sourceString: sourceLines[semanticToken.line].slice(
				semanticToken.start,
				semanticToken.start + semanticToken.length
			),
		};
	}
}
class CppRefactorContext implements vscode.Disposable {
	subscriptions: vscode.Disposable[] = [];
	// client: CppRefactorClient;
	// recppPath: string | undefined;
	// clangdPath: string | undefined;
	// buildDir: string | undefined;
	usedWorkSpaceDir: string;
	clangdProcess: child.ChildProcess;
	cppSymbolIndex: CppSymbolIndex = new CppSymbolIndex([], []);
	requestId: number = 1;
	outputChannel: vscode.OutputChannel;
	initialized: boolean = false;
	semanticTokensLegend: vscodelc.SemanticTokensLegend = {
		tokenModifiers: [],
		tokenTypes: [],
	};
	uri: string =
		'file:///home/waec_mi/Repos/franka_logging/include/franka_logging/backtrace_exception.h';
	requests = new Map();
	// documents = new Map();
	stdoutCB: (requestId: number, data: any) => any;
	openedDocuments = new Map();

	constructor(globalStoragePath: string, outputChannel: vscode.OutputChannel) {
		this.outputChannel = outputChannel;
		this.usedWorkSpaceDir = cfg.getWorkspaceFolder();

		outputChannel.appendLine('Build dir: ' + cfg.getBuildDir());
		const args = ['--compile-commands-dir=' + cfg.getBuildDir(), '--log=verbose'];
		this.stdoutCB = (requestId: number, data: any) => {
			outputChannel.appendLine('new stdout for request ' + requestId + ':\n' + data);

			if (typeof data === 'string') {
				throw new Error('Received string on stdout instead of buffer!');
			} else if (typeof data === 'object') {
				const objects = this.parseStdOut(data);
				for (const obj of objects) {
					if (obj.id && obj.id == requestId) {
						outputChannel.appendLine('Found obj in data stream for request ' + requestId);
						return obj;
					}
					outputChannel.appendLine(
						'Found stray obj in data stream with request id' + obj.id
					);
				}
				return undefined;
				// throw Error(
				// 	'Received stdout buffer from clangd with no content:\n' + data.toString()
				// );
			} else {
				outputChannel.appendLine('Not a buffer reply! type: ' + typeof data);
			}
			throw Error('Received invalid stdout buffer from clangd');
		};
		this.clangdProcess = child.spawn(cfg.getClangdPath(), args);

		this.clangdProcess.stdout.on('data', (data: any) => {
			// outputChannel.appendLine('new stdout:\n' + data);

			if (typeof data === 'string') {
				throw new Error('Received string on stdout instead of buffer!');
			} else if (typeof data === 'object') {
				const objects = this.parseStdOut(data);
				for (const obj of objects) {
					if (!obj.id) {
						// outputChannel.appendLine('Got notification: ' + JSON.stringify(obj));
					}
				}
			} else {
				outputChannel.appendLine('Not a string reply! type: ' + typeof data);
			}
		});
		this.clangdProcess.stderr.on('data', (data) => {
			outputChannel.appendLine('new stderr:\n' + data);
		});

		this.clangdProcess.on('close', (code) => {
			if (code !== 0) {
				outputChannel.appendLine(`clangd process exited with code ${code}`);
			}
		});

		const clientCapabilities: vscodelc.ClientCapabilities = {
			textDocument: {
				semanticTokens: {
					requests: { full: { delta: false } },
					tokenTypes: ['class', 'function'],
					tokenModifiers: ['static', 'declaration', 'definition'],
					formats: [],
				},
			},
		};

		const initRequestParams: vscodelc.InitializeParams = {
			processId: process.pid,
			rootUri: 'file://' + this.usedWorkSpaceDir,
			capabilities: clientCapabilities,
			workspaceFolders: [
				{ uri: 'file://' + this.usedWorkSpaceDir, name: 'workspaceFolder' },
			],
		};
		const initRequest = this.createRequest('initialize', initRequestParams);

		{
			const processInitResult = (obj: any) => {
				if (obj.result.capabilities.semanticTokensProvider) {
					const semanticTokensProvider = obj.result.capabilities.semanticTokensProvider;
					// outputChannel.appendLine('result: ' + semanticTokensProvider);
					this.semanticTokensLegend = semanticTokensProvider.legend;
					this.cppSymbolIndex = new CppSymbolIndex(
						this.semanticTokensLegend.tokenTypes,
						this.semanticTokensLegend.tokenModifiers
					);
					this.sendNotification(this.createNotification('initialized', {}));
					this.initialized = true;
					// setTimeout(() => {
					// 	try {
					// 		this.sendOpenDocumentNotification(this.uri);
					// 	} catch (err) {
					// 		this.outputChannel.appendLine('Error: ' + err);
					// 	}
					// }, 100);
					// setTimeout(() => {
					// 	this.requestSymbolInformation(this.uri);
					// }, 200);
				} else {
					outputChannel.appendLine(
						'your clangd version does not provide semantic tokens (need at least v11.0)! ' +
							JSON.stringify(obj, undefined, 4)
					);
				}
			};
			this.sendRequest(initRequest).then(processInitResult);
		}
	}

	parseStdOut(data: Buffer): any[] {
		var dataString = data.toString();
		const headerString = 'Content-Length: ';
		const result = [];
		while (dataString.startsWith(headerString)) {
			const lines = dataString.split('\n');
			const contentLength: number = +lines[0].slice(headerString.length);
			const remainingContent = lines.slice(2).join('\n');
			const jsonString: string = remainingContent.slice(0, contentLength);
			const obj = JSON.parse(jsonString);
			result.push(obj);
			// if (obj.id && obj.id == requestId) {
			// 	return obj;
			// 	// try {
			// 	// 	outputChannel.appendLine('Calling callback for result on request ' + obj.id);
			// 	// 	return this.requests.get(obj.id).callback(obj);
			// 	// } catch (err) {
			// 	// 	outputChannel.appendLine('Result processing failed: ' + err);
			// 	// }
			// }
			// else {
			// 	outputChannel.appendLine('Got notification: ' + jsonString);
			// }
			dataString = remainingContent.slice(contentLength);
		}
		return result;
	}

	dispose() {
		this.subscriptions.forEach((d) => {
			d.dispose();
		});
		this.subscriptions = [];
		if (this.clangdProcess) {
			this.clangdProcess.kill();
		}
	}

	createRequest(method: string, params: any): any {
		const request = {
			jsonrpc: '2.0',
			id: this.requestId,
			method: method,
			params: params,
		};
		this.requests.set(this.requestId, {
			id: this.requestId,
			method: method,
			params: params,
			// callback: cb,
		});
		this.requestId++;
		return request;
	}

	createNotification(method: string, params: any): any {
		const notification = {
			jsonrpc: '2.0',
			method: method,
			params: params,
		};
		return notification;
	}

	sendDocumentOpenedNotification(document: vscode.TextDocument) {
		const uriString = document.uri.toString();
		const uri = vscode.Uri.parse(uriString);
		// const url = new URL(uri);
		// if (!fs.existsSync(uri.path)) {
		// 	throw new Error('File does not exist: ' + uri.path);
		// }
		if (this.openedDocuments.has(uriString)) {
			return;
		}
		this.openedDocuments.set(uriString, true);
		const fileContent = document.getText(); //fs.readFileSync(uri.path).toString();
		// const uri = 'file://' + path;
		const doc = vscodelc.TextDocumentItem.create(
			uriString,
			document.languageId,
			document.version,
			fileContent
		);
		const obj: vscodelc.DidOpenTextDocumentParams = { textDocument: doc };
		// this.documents.set(uriString, fileContent);
		const notification = this.createNotification('textDocument/didOpen', obj);
		this.sendNotification(notification);
	}

	sendDocumentChangedNotification(
		document: vscode.TextDocument,
		newContentChanges: readonly vscode.TextDocumentContentChangeEvent[]
	) {
		const uri = document.uri;

		// const url = new URL(uri);
		// if (!fs.existsSync(uri.path)) {
		// 	throw new Error('File does not exist: ' + uri.path);
		// }
		const fileContent = document.getText();

		// const contentChangesCopy: Mutable<vscode.TextDocumentContentChangeEvent[]> = clone(
		// 	newContentChanges
		// );
		// const uri = 'file://' + path;
		// const bla : vscodelc.DidChangeTextDocumentParams;
		var changes = [];
		for (const i in newContentChanges) {
			const c = newContentChanges[i];
			const obj = {
				// TODO: JSON.stringify fucks up the object. so we do it manually
				range: { start: c.range.start, end: c.range.end },
				rangeLength: c.rangeLength,
				text: c.text,
			};
			changes.push(obj);
		}
		const doc = vscodelc.TextDocumentItem.create(uri.toString(), 'cpp', 0, fileContent);
		const obj = {
			textDocument: vscodelc.VersionedTextDocumentIdentifier.create(
				document.uri.toString(),
				document.version
			),
			contentChanges: changes,
		};
		// this.documents.set(document.uri.fsPath, fileContent);
		const notification = this.createNotification('textDocument/didChange', obj);
		this.sendNotification(notification);
	}

	async requestSymbolInformation(document: vscode.TextDocument) {
		const uri = document.uri.toString();
		// var uri: string = 'file://' + path;
		const obj: vscodelc.SemanticTokensParams = {
			textDocument: { uri: uri },
		};
		if (this.cppSymbolIndex.index.has(uri)) {
			const storedVersion = this.cppSymbolIndex.index.get(uri).documentVersion;
			if (storedVersion === document.version) {
				return this.cppSymbolIndex;
			}
		}
		const request = this.createRequest('textDocument/semanticTokens/full', obj);
		const processSymbolInformationResult = (obj: any) => {
			if (obj) {
				this.cppSymbolIndex.upsert(document, obj.result.data);
			} else {
				// throw Error('Obj is undefined for uri ' + uri);
				return undefined;
			}
			// this.outputChannel.appendLine(
			// 	'keys: ' + JSON.stringify(this.cppSymbolIndex.index.get(uri))
			// );
			// var semanticSourceTokens: SemanticSourceToken[] = [];
			// const uriString = uri.toString();
			// const sourceLines = this.documents.get(uriString).split('\n');
			// const semanticTokensOfFile = this.cppSymbolIndex.index.get(uriString);
			// semanticTokensOfFile.forEach((item: SemanticToken, index: number) => {
			// 	semanticSourceTokens.push(
			// 		CppSymbolIndex.getSourceForSemanticToken(sourceLines, item)
			// 	);
			// });

			// this.outputChannel.appendLine(
			// 	'semantic source token parsed!' //: ' + JSON.stringify(semanticSourceTokens)
			// );
			return this.cppSymbolIndex;
		};
		return this.sendRequest(request).then(processSymbolInformationResult);
	}

	sendNotification(notification: any) {
		const notificationString = JSON.stringify(notification);

		// this.outputChannel.appendLine('Notification:\n' + notificationString);

		if (this.clangdProcess) {
			this.clangdProcess.stdin.write(
				'Content-Length: ' +
					notificationString.length +
					'\r\n' +
					'\r\n' +
					notificationString
			);
		}
	}

	async sendRequest(request: any): Promise<any> {
		const requestString = JSON.stringify(request);
		const promise = new Promise((resolve, reject) => {
			this.outputChannel.appendLine('Request:\n' + requestString);

			const cb = (data: any) => {
				try {
					const result = this.stdoutCB(request.id, data);

					if (result) {
						this.clangdProcess.stdout.removeListener('data', cb);
						resolve(result);
					} else {
						this.outputChannel.appendLine('Waiting for more data on stdout');
					}
				} catch (e) {
					reject(`Request failed: ${e}`);
				}
			};
			this.clangdProcess.stdout.on('data', cb);
			this.clangdProcess.stdin.write(
				'Content-Length: ' + requestString.length + '\r\n' + '\r\n' + requestString
			);
		});
		return promise;
	}
}

class ReCppHolder implements vscode.Disposable {
	refactorContext: CppRefactorContext | undefined;

	dispose() {
		if (this.refactorContext) {
			this.refactorContext.dispose();
		}
	}

	onDocumentChanged(e: vscode.TextDocumentChangeEvent) {
		if (this.refactorContext && fs.existsSync(e.document.uri.fsPath)) {
			this.refactorContext.outputChannel.appendLine(
				'Document changed: ' +
					e.document.uri.toString() +
					' changes: ' +
					e.contentChanges.length
			);

			this.refactorContext.sendDocumentChangedNotification(e.document, e.contentChanges);
			this.refactorContext.requestSymbolInformation(e.document);
		}
	}

	onDocumentOpened(document: vscode.TextDocument) {
		if (this.refactorContext && fs.existsSync(document.uri.fsPath)) {
			this.refactorContext.outputChannel.appendLine(
				'Document opened: ' + document.uri.toString() + ' version; ' + document.version
			);

			this.refactorContext.sendDocumentOpenedNotification(document);
			this.refactorContext.requestSymbolInformation(document);
		}
	}
}

export async function activate(context: vscode.ExtensionContext) {
	vscode.window.showInformationMessage('Activated recpp extension');

	const outputChannel = vscode.window.createOutputChannel('cpp-refactor');
	const reCppHolder = new ReCppHolder();
	context.subscriptions.push(reCppHolder);
	const recppCommandHandler = (args: any) => {
		vscode.window.withProgress(
			{
				location: vscode.ProgressLocation.Notification,
				title: 'Running recpp',
				cancellable: false,
			},
			(progress, token) => {
				if (!cfg.isWorkspaceOpened()) {
					outputChannel.appendLine(`No workspace opened - cannot refactor`);
					return new Promise<void>((resolve) => {
						resolve();
					});
				}
				const cmd = `${cfg.getRecppPath()} ${args.join(' ')}`;
				outputChannel.appendLine(`Running recpp:\n ${cmd}`);

				// const stdout: string = child.execSync(cmd).toString();
				// const stdout: string = child.execSync('ls /tmp').toString();
				// outputChannel.appendLine('stdout:\n' + stdout);
				const p = new Promise<void>((resolve, reject) => {
					const proc = child
						.exec(cmd, (err, stdout, stderr) => {
							outputChannel.appendLine('stdout is:' + stdout);
							outputChannel.appendLine('stderr is:' + stderr);
							outputChannel.appendLine('error is:' + err);
						})
						.on('exit', (code) => {
							outputChannel.appendLine('final exit code is ' + code.toString());
							if (code == 0) {
								resolve();
							} else {
								reject();
							}
						})
						.on('close', (code) => {
							outputChannel.appendLine('final close code is ' + code.toString());
							if (code == 0) {
								resolve();
							} else {
								reject();
							}
						});
				});

				return p;
			}
		);
	};

	context.subscriptions.push(
		vscode.commands.registerCommand(recppCommand, recppCommandHandler)
	);

	context.subscriptions.push(outputChannel);
	context.subscriptions.push(
		vscode.languages.registerCodeActionsProvider(
			'cpp',
			new CppRefactorActionProvider(reCppHolder, context.globalStoragePath, outputChannel),
			{
				providedCodeActionKinds: CppRefactorActionProvider.providedCodeActionKinds,
			}
		)
	);
	context.subscriptions.push(
		vscode.workspace.onDidChangeTextDocument((e) => {
			reCppHolder.onDocumentChanged(e);
		})
	);

	context.subscriptions.push(
		vscode.workspace.onDidOpenTextDocument((e) => {
			reCppHolder.onDocumentOpened(e);
		})
	);

	// const emojiDiagnostics = vscode.languages.createDiagnosticCollection("emoji");
	// context.subscriptions.push(emojiDiagnostics);

	// subscribeToDocumentChanges(context, emojiDiagnostics);

	// context.subscriptions.push(
	// 	vscode.languages.registerCodeActionsProvider('cpp', new Emojinfo(), {
	// 		providedCodeActionKinds: Emojinfo.providedCodeActionKinds
	// 	})
	// );

	// context.subscriptions.push(
	// 	vscode.commands.registerCommand(COMMAND, () => vscode.env.openExternal(vscode.Uri.parse('https://unicode.org/emoji/charts-12.0/full-emoji-list.html')))
	// );
}

/**
 * Provides code actions for converting :) to a smiley emoji.
 */
export class CppRefactorActionProvider implements vscode.CodeActionProvider {
	public static readonly providedCodeActionKinds = [vscode.CodeActionKind.Refactor];

	constructor(
		private reCppHolder: ReCppHolder,
		private globalStoragePath: string,
		private outputChannel: vscode.OutputChannel
	) {}
	public provideCodeActions(
		document: vscode.TextDocument,
		range: vscode.Range
	): Promise<vscode.CodeAction[]> | undefined {
		if (!cfg.isWorkspaceOpened()) {
			this.outputChannel.appendLine('No workspace opened');
			return new Promise<vscode.CodeAction[]>((resolve) => {
				resolve([]);
			});
		}
		if (
			this.reCppHolder.refactorContext &&
			this.reCppHolder.refactorContext.usedWorkSpaceDir != cfg.getWorkspaceFolder()
		) {
			this.reCppHolder.refactorContext.dispose();
			this.reCppHolder.refactorContext = undefined;
		}
		if (!this.reCppHolder.refactorContext) {
			this.reCppHolder.refactorContext = new CppRefactorContext(
				this.globalStoragePath,
				this.outputChannel
			);
		}

		const refactorContext = this.reCppHolder.refactorContext;
		refactorContext.sendDocumentOpenedNotification(document);
		// this.refactorContext.outputChannel.appendLine('Request for providing code actions');
		// this.refactorContext.outputChannel.appendLine('sent document open notif');
		const promisedCodeActions: Promise<vscode.CodeAction[]> | undefined = new Promise(
			(resolve, reject) => {
				try {
					const uriString = document.uri.toString();
					// this.refactorContext.outputChannel.appendLine('requesting symbols');
					const wordRange = document.getWordRangeAtPosition(range.start);
					if (!wordRange) {
						reject(Error('invalid word range selected'));
						return;
					}
					const fileOffset = document.offsetAt(range.start);
					const currentWord = document.getText(wordRange);
					if (!vscode.workspace.workspaceFolders) {
						reject(Error('no workspace folder is opened!'));
						return;
					}
					const wsFolder = cfg.getWorkspaceFolder();
					var recppArgs = [
						'-s',
						currentWord,
						'-f',
						document.uri.fsPath,
						'-o',
						fileOffset.toString(),
						'--workspace-folder',
						wsFolder,
						'-p',
						cfg.getBuildDir(),
						document.uri.fsPath,
					];
					const clangExtraArgs = cfg.getClangExtraArgs();
					for (const k in clangExtraArgs) {
						recppArgs.push('--extra-arg');
						recppArgs.push(`"${clangExtraArgs[k]}"`);
					}

					const extraArgs = cfg.getExtraArgs();
					for (const k in extraArgs) {
						recppArgs.push(`"${extraArgs[k]}"`);
					}

					const cppSymbolIndex = refactorContext.requestSymbolInformation(document);
					cppSymbolIndex.then((cppSymbolIndex) => {
						// this.refactorContext.outputChannel.appendLine('getting symbol type');
						if (!cppSymbolIndex) {
							refactorContext.outputChannel.appendLine(
								'Didnt get a symbol response from clangd'
							);
							reject(Error('Didnt get a response from clangd'));
							return;
						}
						refactorContext.outputChannel.appendLine('Got symbols');
						const symbolType = cppSymbolIndex.getSymbolType(
							uriString,
							range.start.line,
							range.start.character
						);
						// this.refactorContext.outputChannel.appendLine('creating action');
						const content = document.getText(); //refactorContext.documents.get(uriString);
						const lineContent = content.split('\n');

						var codeActions: vscode.CodeAction[] = [];
						// this.refactorContext.outputChannel.appendLine('Symbol Type: ' + symbolType);
						if (symbolType == 'function' || symbolType == 'member') {
							const isFunctionDefinition = utils.isFunctionDefinition(content, range.start);
							if (
								utils.checkNextString(
									lineContent[range.start.line],
									range.start.character,
									'::',
									false
								) &&
								isFunctionDefinition
							) {
								if (document.uri.fsPath.endsWith('.cpp')) {
									codeActions.push(
										new CodeAction(
											'Move definition to header',
											vscode.CodeActionKind.Refactor
										)
									);
									codeActions.push(
										new CodeAction(
											'Move definition to inside of class declaration',
											vscode.CodeActionKind.Refactor
										)
									);
								} else if (document.uri.fsPath.endsWith('.h')) {
									var action = this.getDef2CppAction(recppArgs);
									codeActions.push(action);
									codeActions.push(
										new CodeAction(
											'Move definition to inside of class declaration',
											vscode.CodeActionKind.Refactor
										)
									);
								}
							} else if (isFunctionDefinition) {
								var action = this.getDef2CppAction(recppArgs);
								codeActions.push(action);
								codeActions.push(
									new CodeAction(
										'Move definition to outside of class declaration',
										vscode.CodeActionKind.Refactor
									)
								);
							}
						} else if (symbolType == 'class') {
							const previousWord = utils.getNextWord(
								lineContent[range.start.line],
								range.start.character,
								false
							);
							// this.refactorContext.outputChannel.appendLine('Previous word: ' + previousWord);
							if (previousWord == 'class' || previousWord == 'struct') {
								codeActions.push(
									new CodeAction('Move to new file', vscode.CodeActionKind.Refactor)
								);
								codeActions.push(
									new CodeAction(
										'Move all functions to cpp',
										vscode.CodeActionKind.Refactor
									)
								);

								codeActions.push(
									new CodeAction(
										'Move all functions to header',
										vscode.CodeActionKind.Refactor
									)
								);

								codeActions.push(
									new CodeAction(
										'Implement virtual functions',
										vscode.CodeActionKind.Refactor
									)
								);
							}
						}
						resolve(codeActions);
					});
				} catch (e) {
					reject(`Error: ${e}`);
				}
			}
		);

		// const wordRange = document.getWordRangeAtPosition(range.start);
		// console.log('proposing fixes for ', wordRange);
		// // console.log("callback received for document " + document.uri + " ", range);
		// if (!this.isAtStartOfSmiley(document, range)) {
		// 	console.log('not at smiley start! ' + document.uri + ' ', range.start);
		// 	return;
		// }

		// const replaceWithSmileyCatFix = this.createFix(document, range, '😺');

		// const replaceWithSmileyFix = this.createFix(document, range, '😀');
		// // Marking a single fix as `preferred` means that users can apply it with a
		// // single keyboard shortcut using the `Auto Fix` command.
		// replaceWithSmileyFix.isPreferred = true;

		// const replaceWithSmileyHankyFix = this.createFix(document, range, '💩');

		// const commandAction = this.createCommand();
		// console.log('proposing fixes!');
		return promisedCodeActions;
	}

	private getDef2CppAction(recppArgs: string[]) {
		var action = new CodeAction('Move definition to cpp', vscode.CodeActionKind.Refactor);
		action.command = {
			command: recppCommand,
			arguments: [recppArgs],
			title: 'Move definition to cpp',
			tooltip: 'This will try to move the function definition the corresponding cpp.',
		};
		return action;
	}

	private isAtStartOfSmiley(document: vscode.TextDocument, range: vscode.Range) {
		const start = range.start;
		const line = document.lineAt(start.line);
		return line.text[start.character] === ':' && line.text[start.character + 1] === ')';
	}

	private createFix(
		document: vscode.TextDocument,
		range: vscode.Range,
		emoji: string
	): vscode.CodeAction {
		const fix = new vscode.CodeAction(
			`Convert to ${emoji}`,
			vscode.CodeActionKind.Refactor
		);
		fix.edit = new vscode.WorkspaceEdit();
		fix.edit.replace(
			document.uri,
			new vscode.Range(range.start, range.start.translate(0, 2)),
			emoji
		);
		return fix;
	}
}
