import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

import * as vscode from 'vscode';

suite('Extension Test Suite', () => {
	vscode.window.showInformationMessage('Start all tests.');

	test('manifest contributes checkpoint-only sessions view surface', () => {
		const manifestPath = path.resolve(__dirname, '../../package.json');
		const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as {
			contributes?: {
				views?: Record<string, Array<{ id: string; name?: string; when?: string }>>;
				viewsWelcome?: Array<{ view: string; contents: string }>;
				commands?: Array<{ command: string }>;
			};
		};

		const contributedViews = manifest.contributes?.views?.['session-bridge'] ?? [];
		assert.strictEqual(
			contributedViews.some((view) => view.id === 'session.bridge.entire.recovery'),
			false,
		);
		assert.strictEqual(
			contributedViews.some((view) => view.id === 'session.bridge.entire.activeSessions'),
			false,
		);
		const checkpointSessionsView = contributedViews.find((view) => view.id === 'session.bridge.entire.sessions');
		assert.ok(checkpointSessionsView);
		assert.strictEqual(checkpointSessionsView?.name, 'Checkpoint Sessions');

		const welcomeViews = manifest.contributes?.viewsWelcome ?? [];
		assert.strictEqual(
			welcomeViews.some((view) => view.view === 'session.bridge.entire.recovery'),
			false,
		);
		assert.strictEqual(
			welcomeViews.some((view) => view.view === 'session.bridge.entire.checkpoints' && view.contents.includes('session.bridge.entire.fetchCheckpointBranch')),
			false,
		);

		const commands = new Set((manifest.contributes?.commands ?? []).map((command) => command.command));
		assert.strictEqual(commands.has('session.bridge.entire.runDoctor'), false);
		assert.strictEqual(commands.has('session.bridge.entire.resumeBranch'), false);
		assert.strictEqual(commands.has('session.bridge.entire.clean'), true);
		assert.strictEqual(commands.has('session.bridge.entire.reset'), true);
		assert.strictEqual(commands.has('session.bridge.entire.showTrace'), true);
	});
});
