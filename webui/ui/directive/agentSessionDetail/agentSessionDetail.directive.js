angular.module('kityminderEditor').directive('agentSessionDetail', [
	'agentSessionService',
	function(agentSessionService) {
		return {
			restrict: 'A',
			templateUrl: 'ui/directive/agentSessionDetail/agentSessionDetail.html',
			link: function(scope, element) {
				var modalHost = element && element[0];
				var editorContainer = modalHost && modalHost.closest
					? modalHost.closest('.minder-editor-container')
					: null;
				var ACTIVE_STATUSES = {
					allocated: true,
					starting: true,
					running: true,
					interrupting: true,
					disconnected: true
				};
				var KIND_LABELS = {
					user: 'transcriptUser',
					assistant: 'transcriptAssistant',
					reasoning: 'transcriptReasoning',
					plan: 'transcriptPlan',
					command: 'transcriptCommand',
					'file-change': 'transcriptFileChange',
					'mcp-tool': 'transcriptMcpTool',
					tool: 'transcriptTool',
					collaboration: 'transcriptCollaboration',
					'web-search': 'transcriptWebSearch',
					image: 'transcriptImage',
					approval: 'transcriptApproval',
					status: 'transcriptStatus',
					error: 'transcriptError'
				};
				scope.sessionDetail = {
					visible: false,
					session: null,
					transcript: [],
					turns: [],
					outcome: null,
					live: false,
					loading: false,
					loadError: null
				};

				function apply() {
					if (!scope.$$phase && !scope.$root.$$phase) scope.$apply();
				}

				function setModalLayerVisible(visible) {
					if (!element) return;
					if (visible && element.addClass) element.addClass('is-open');
					if (!visible && element.removeClass) element.removeClass('is-open');
					if (editorContainer && editorContainer.classList) {
						editorContainer.classList.toggle('has-session-detail-open', visible);
					}
				}

				function nodeTitle(nodeId) {
					var title = nodeId;
					if (!nodeId || !window.minder || !window.minder.getRoot) return title;
					window.minder.getRoot().traverse(function(node) {
						if (node.getData('id') === nodeId) title = node.getText() || nodeId;
					});
					return title;
				}

				function stringify(value) {
					if (value === undefined || value === null || value === '') return '';
					if (typeof value === 'string') return value;
					try { return JSON.stringify(value, null, 2); } catch (_error) { return String(value); }
				}

				function decorateEntry(raw) {
					var entry = Object.assign({}, raw);
					var detail = raw && raw.detail && typeof raw.detail === 'object' ? raw.detail : {};
					entry.labelKey = KIND_LABELS[entry.kind] || 'transcriptTool';
					entry.hasReasoningContent = !!(entry.summary || entry.text);
					entry.detailView = {
						cwd: detail.cwd,
						output: stringify(detail.output || detail.aggregatedOutput),
						arguments: stringify(detail.arguments || detail.request),
						result: stringify(detail.result || detail.contentItems),
						error: stringify(detail.error),
						progress: stringify(detail.progress),
						diff: stringify(detail.diff),
						exitCode: detail.exitCode === null ? undefined : detail.exitCode,
						durationMs: detail.durationMs === null ? undefined : detail.durationMs,
						changes: (Array.isArray(detail.changes) ? detail.changes : []).map(function(change) {
							return {
								path: change.path,
								kind: change.kind && (change.kind.type || change.kind) || 'update',
								diff: change.diff || ''
							};
						})
					};
					entry.hasDetail = entry.detailView.output || entry.detailView.arguments || entry.detailView.result ||
						entry.detailView.error || entry.detailView.progress || entry.detailView.diff ||
						entry.detailView.cwd || entry.detailView.exitCode !== undefined ||
						entry.detailView.durationMs !== undefined || entry.detailView.changes.length;
					return entry;
				}

				function groupTurns(transcript) {
					var groups = [];
					var byId = {};
					(transcript || []).forEach(function(entry) {
						var turnId = entry.turnId || 'session';
						if (!byId[turnId]) {
							byId[turnId] = { id: turnId, entries: [], index: groups.length + 1 };
							groups.push(byId[turnId]);
						}
						byId[turnId].entries.push(entry);
					});
					return groups;
				}

				function buildOutcome(session, transcript) {
					var finalResponse = null;
					var files = {};
					var commandCount = 0;
					var commandPassed = 0;
					var toolCount = 0;
					var receipt = null;
					(transcript || []).forEach(function(entry) {
						if (entry.kind === 'assistant' && entry.text && (entry.phase === 'final_answer' || !finalResponse)) {
							finalResponse = entry;
						}
						if (entry.kind === 'command') {
							commandCount += 1;
							if (entry.detailView.exitCode !== undefined
								? entry.detailView.exitCode === 0
								: entry.status === 'completed') commandPassed += 1;
						}
						if (entry.kind === 'mcp-tool' || entry.kind === 'tool' || entry.kind === 'collaboration') toolCount += 1;
						if (entry.kind === 'file-change') {
							entry.detailView.changes.forEach(function(change) {
								if (change.path) files[change.path] = change;
							});
						}
					});
					if (finalResponse && finalResponse.text) {
						try {
							var parsed = JSON.parse(finalResponse.text);
							if (parsed && typeof parsed === 'object' && typeof parsed.summary === 'string') receipt = parsed;
						} catch (_error) { /* A normal prose final answer is expected for Providers without receipts. */ }
					}
					var fileList = Object.keys(files).map(function(path) { return files[path]; });
					var artifacts = (session.artifacts || []).concat(receipt && receipt.artifacts || []);
					var deliverablesByPath = {};
					fileList.concat(artifacts).forEach(function(item) {
						if (item && item.path) deliverablesByPath[item.path] = item;
					});
					return {
						finalResponse: finalResponse,
						finalResponseText: receipt && receipt.summary || finalResponse && finalResponse.text || '',
						summary: session.summary || receipt && receipt.summary || '',
						artifacts: artifacts,
						deliverables: Object.keys(deliverablesByPath).map(function(path) { return deliverablesByPath[path]; }),
						validations: receipt && receipt.validations || [],
						blocker: receipt && receipt.blocker || '',
						files: fileList,
						commandCount: commandCount,
						commandPassed: commandPassed,
						toolCount: toolCount,
						turnCount: groupTurns(transcript).filter(function(turn) { return turn.id !== 'session'; }).length
					};
				}

				function mergeTranscript(base, live) {
					var result = [];
					var indexes = {};
					(base || []).concat(live || []).forEach(function(entry) {
						if (!entry || !entry.id) return;
						if (indexes[entry.id] !== undefined) result[indexes[entry.id]] = Object.assign({}, result[indexes[entry.id]], entry);
						else {
							indexes[entry.id] = result.length;
							result.push(Object.assign({}, entry));
						}
					});
					return result.map(decorateEntry);
				}

				function hydrate(raw) {
					if (!raw || !raw.executionId) return;
					var live = agentSessionService.getLiveSessionDetail
						? agentSessionService.getLiveSessionDetail(raw.executionId) || {}
						: {};
					var session = Object.assign({}, raw, live, {
						session: Object.assign({}, raw.session || {}, live.session || {})
					});
					session.nodeTitle = nodeTitle(session.nodeId) || session.title || session.executionId;
					var transcript = mergeTranscript(raw.transcript, live.transcript);
					scope.sessionDetail.session = session;
					scope.sessionDetail.transcript = transcript;
					scope.sessionDetail.turns = groupTurns(transcript);
					scope.sessionDetail.outcome = buildOutcome(session, transcript);
					scope.sessionDetail.live = ACTIVE_STATUSES[session.status] === true;
				}

				function loadProviderDetail(raw) {
					if (!agentSessionService.querySessionDetail) return;
					scope.sessionDetail.loading = true;
					scope.sessionDetail.loadError = null;
					agentSessionService.querySessionDetail(raw.executionId, raw.nodeId).then(function(result) {
						if (!scope.sessionDetail.visible || scope.sessionDetail.executionId !== raw.executionId) return;
						scope.sessionDetail.loading = false;
						hydrate(Object.assign({}, raw, result && result.session || {}));
					}, function(error) {
						if (!scope.sessionDetail.visible || scope.sessionDetail.executionId !== raw.executionId) return;
						scope.sessionDetail.loading = false;
						scope.sessionDetail.loadError = error && error.message || String(error);
					});
				}

				function focusDetail() {
					window.setTimeout(function() {
						var detail = document.getElementById('agent-session-detail-drawer');
						if (detail && detail.focus) detail.focus();
					}, 0);
				}

				function open(event) {
					var detail = event.detail || {};
					if (!detail.session || !detail.session.executionId) return;
					scope.sessionDetail.visible = true;
					setModalLayerVisible(true);
					scope.sessionDetail.source = detail.source === 'activity' ? 'activity' : 'history';
					scope.sessionDetail.executionId = detail.session.executionId;
					hydrate(detail.session);
					loadProviderDetail(detail.session);
					apply();
					focusDetail();
				}

				function close(restoreFocus) {
					if (!scope.sessionDetail.visible) return;
					var executionId = scope.sessionDetail.executionId;
					scope.sessionDetail.visible = false;
					setModalLayerVisible(false);
					scope.sessionDetail.loading = false;
					apply();
					if (!restoreFocus) return;
					window.setTimeout(function() {
						var trigger = document.querySelector('[data-execution-id="' + executionId + '"]');
						if (trigger && trigger.focus) trigger.focus();
					}, 0);
				}

				function closeFromEvent() { close(false); }

				function closeFromBackdrop(event) {
					if (!scope.sessionDetail.visible || event.target !== modalHost) return;
					close(true);
				}

				function handleEscape(event) {
					if (event.key !== 'Escape' || !scope.sessionDetail.visible) return;
					event.preventDefault();
					event.stopImmediatePropagation();
					close(true);
				}

				scope.closeSessionDetail = function() { close(true); };
				scope.sessionDetailSourceLabel = function() {
					return scope.sessionDetail.source === 'activity' ? 'activityOverview' : 'history';
				};

				document.addEventListener('agent-session-detail-open', open);
				document.addEventListener('agent-session-detail-close', closeFromEvent);
				document.addEventListener('keydown', handleEscape, true);
				if (modalHost && modalHost.addEventListener) modalHost.addEventListener('click', closeFromBackdrop);
				scope.$on('agent-session-live-detail', function(_event, detail) {
					if (!scope.sessionDetail.visible || !detail || detail.executionId !== scope.sessionDetail.executionId) return;
					hydrate(Object.assign({}, scope.sessionDetail.session, detail));
				});
				scope.$on('$destroy', function() {
					document.removeEventListener('agent-session-detail-open', open);
					document.removeEventListener('agent-session-detail-close', closeFromEvent);
					document.removeEventListener('keydown', handleEscape, true);
					if (modalHost && modalHost.removeEventListener) modalHost.removeEventListener('click', closeFromBackdrop);
					setModalLayerVisible(false);
				});
			}
		};
	}
]);
