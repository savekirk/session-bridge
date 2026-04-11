import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

import * as vscode from 'vscode';

suite('Extension Test Suite', () => {
	vscode.window.showInformationMessage('Start all tests.');

	test('manifest removes recovery view but keeps recovery commands', () => {
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
		const activeSessionsView = contributedViews.find((view) => view.id === 'session.bridge.entire.activeSessions');
		assert.ok(activeSessionsView);
		assert.strictEqual(activeSessionsView?.name, 'Active Sessions');
		assert.strictEqual(
			activeSessionsView?.when,
			'session.bridge.state.enabled && session.bridge.state.has-active-sessions',
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
		assert.strictEqual(commands.has('session.bridge.entire.runDoctor'), true);
		assert.strictEqual(commands.has('session.bridge.entire.resumeBranch'), true);
		assert.strictEqual(commands.has('session.bridge.entire.clean'), true);
		assert.strictEqual(commands.has('session.bridge.entire.reset'), true);
		assert.strictEqual(commands.has('session.bridge.entire.showTrace'), true);
	});
});
