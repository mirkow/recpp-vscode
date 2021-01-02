import { Position } from 'vscode';

var lineColumn = require('line-column');

export function removeQuotedStrings(content: string): string {
	return content.replace(/(["'])(?:(?=(\\?))\2.)*?\1/gms, '');
}

export function removeComments(content: string): string {
	content = content.replace(/\/\*.*?\*\//gms, '');
	content = content.replace(/\/\/.*/g, '');

	return content;
}

export function replaceAllMatches(s: string, re: RegExp, replacement: string = ''): string {
	var m;
	do {
		m = re.exec(s);
		if (m && m.length > 0) {
			s = replaceRange(s, m.index, m[0].length, replacement.repeat(m[0].length));
		}
	} while (m);
	return s;
}

export function replaceRange(s: string, start: number, length: number, substitute: string) {
	return s.substring(0, start) + substitute + s.substring(start + length);
}

export function replaceQuotedStrings(content: string, replacement: string): string {
	var re = /(["'])(?:(?=(\\?))\2.)*?\1/gms;
	return replaceAllMatches(content, re, '*');
}

export function replaceComments(content: string, replacement: string = ''): string {
	content = replaceAllMatches(content, /\/\*.*?\*\//gms, '*');
	content = replaceAllMatches(content, /\/\/.*/g, '*');
	return content;
}

export function isFunctionDefinition(content: string, start: Position) {
	const index = lineColumn(content, { origin: 0 }).toIndex(start.line, start.character);
	// console.log('start', start, ' index:', index);
	content = replaceComments(content, '*');
	content = replaceQuotedStrings(content, '*');
	var openBrackets: number = 0;
	var i = index;
	var foundFirstBracket = false;
	while (i < content.length) {
		const c = content.charAt(i);
		if (openBrackets == 0 && foundFirstBracket) {
			if (c == ';') {
				return false;
			}
			if (c == '{') {
				return true;
			}
		}
		if (c == '(') {
			openBrackets++;
			foundFirstBracket = true;
		}
		if (c == ')') {
			openBrackets--;
		}

		i++;
	}
	return false;
}

export function isSymbolCharacter(c: number): boolean {
	if (c >= 97 && c <= 122) return true; // a-z
	if (c >= 65 && c <= 90) return true; // A-Z
	if (c == 95) return true; // _
	if (c >= 48 && c <= 57) return true; // 0-9

	return false;
}

export function getNextWord(
	content: string,
	position: number,
	forwardDirection: boolean = true
): string {
	var curPos = position;
	const increment = forwardDirection ? 1 : -1;
	// first find end of current word
	var currentWord: string = '';
	while (
		isSymbolCharacter(content.charCodeAt(curPos)) &&
		curPos >= 0 &&
		curPos < content.length
	) {
		currentWord += content.charAt(curPos);
		curPos += increment;
	}
	// now skip all white space characters
	while (content.charCodeAt(curPos) <= 32 && curPos >= 0 && curPos < content.length) {
		curPos += increment;
	}

	// now find next word
	var nextWord: string = '';
	while (
		isSymbolCharacter(content.charCodeAt(curPos)) &&
		curPos >= 0 &&
		curPos < content.length
	) {
		nextWord += content.charAt(curPos);
		curPos += increment;
	}
	if (forwardDirection) {
		return nextWord;
	} else {
		return nextWord.split('').reverse().join('');
	}
}

export function checkNextString(
	content: string,
	position: number,
	comparator: string,
	forwardDirection: boolean = true
): boolean {
	const increment = forwardDirection ? 1 : -1;
	var curPos = position + increment;
	// first find end of current word
	// var currentWord: string = '';
	while (
		isSymbolCharacter(content.charCodeAt(curPos)) &&
		curPos >= 0 &&
		curPos < content.length
	) {
		// currentWord += content.charAt(curPos);
		curPos += increment;
	}
	// now skip all white space characters
	while (content.charCodeAt(curPos) <= 32 && curPos >= 0 && curPos < content.length) {
		curPos += increment;
	}

	// now find next word
	var nextWord: string = '';
	while (content.charCodeAt(curPos) > 32 && curPos >= 0 && curPos < content.length) {
		nextWord += content.charAt(curPos);
		if (nextWord == comparator) {
			return true;
		}
		curPos += increment;
	}
	return false;
}
