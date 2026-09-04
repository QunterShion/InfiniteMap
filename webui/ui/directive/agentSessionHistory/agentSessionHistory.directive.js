angular.module('kityminderEditor').directive('agentSessionHistory', [
    'agentSessionService',
    function(agentSessionService) {
        return {
            restrict: 'A',
            templateUrl: 'ui/directive/agentSessionHistory/agentSessionHistory.html',
			link: function(scope) {
				scope.history = { visible: false, loading: false, sessions: [], total: 0, openingExecutionId: null };
				var storedSessions = [];
				var openStates = {};

                function apply() {
                    if (!scope.$$phase && !scope.$root.$$phase) scope.$apply();
                }

				function announceDrawerState(open, restoreFocus) {
					document.dispatchEvent(new CustomEvent('agent-session-drawer-state', {
						detail: { drawer: 'history', open: open, restoreFocus: restoreFocus === true }
					}));
				}

				function focusDrawer() {
					window.setTimeout(function() {
						var drawer = document.getElementById('agent-session-history-drawer');
						if (drawer && drawer.focus) drawer.focus();
					}, 0);
				}

				function nodeTitle(nodeId) {
					var title = nodeId;
					if (!nodeId || !window.minder || !window.minder.getRoot) return title;
					window.minder.getRoot().traverse(function(node) {
						if (node.getData('id') === nodeId) title = node.getText() || nodeId;
					});
					return title;
				}

				function decorateSessions(sessions) {
					return (sessions || []).map(function(session) {
						var state = openStates[session.executionId] || {};
						return Object.assign({}, session, state, {
							nodeTitle: nodeTitle(session.nodeId)
						});
					});
				}

				function mergeAgentSessions(sessions) {
					var byExecution = {};
					var liveSessions = agentSessionService.listLiveAgentSessions
						? agentSessionService.listLiveAgentSessions()
						: [];
					(sessions || []).concat(liveSessions).forEach(function(session) {
						if (!session || !session.executionId) return;
						if (scope.history.nodeId && session.nodeId !== scope.history.nodeId) return;
						byExecution[session.executionId] = Object.assign({}, byExecution[session.executionId] || {}, session);
					});
					return decorateSessions(Object.keys(byExecution).map(function(executionId) {
						return byExecution[executionId];
					}).sort(function(left, right) {
						return Date.parse(right.updatedAt || 0) - Date.parse(left.updatedAt || 0);
					}));
				}

				function open(event) {
                    var detail = event.detail || {};
					document.dispatchEvent(new CustomEvent('agent-activity-close'));
					document.dispatchEvent(new CustomEvent('agent-session-detail-close'));
                    scope.history = {
                        visible: true,
                        loading: true,
						nodeId: detail.nodeId || null,
						executionId: detail.executionId || null,
                        sessions: [],
                        total: 0,
                        error: null
                    };
                    apply();
					announceDrawerState(true);
					loadHistory();
					focusDrawer();
				}

				function loadHistory() {
					if (!scope.history.visible) return;
					scope.history.loading = true;
					agentSessionService.queryHistory(scope.history.nodeId).then(function(page) {
                        scope.history.loading = false;
						storedSessions = page.sessions || [];
						scope.history.sessions = mergeAgentSessions(storedSessions);
						scope.history.total = scope.history.sessions.length;
                        scope.history.orphan = page.orphan === true;
						scope.history.nextCursor = page.nextCursor || null;
                    }, function(error) {
                        scope.history.loading = false;
                        scope.history.error = error.message || String(error);
					});
				}

                document.addEventListener('agent-session-history-open', open);
				function close(event) {
					if (!scope.history.visible) return;
					scope.history.visible = false;
					announceDrawerState(false, event && event.detail && event.detail.restoreFocus);
					apply();
				}
				document.addEventListener('agent-session-history-close', close);
				scope.closeHistory = function() { close({ detail: { restoreFocus: true } }); };
				function openNative(session, target, mode, fallbackPolicy) {
					if (!session || !session.executionId || session.opening || openStates[session.executionId] && openStates[session.executionId].opening) return;
					var nodeId = session.nodeId || scope.history.nodeId || null;
					openStates[session.executionId] = { opening: true, openError: null, openResult: null };
					scope.history.openingExecutionId = session.executionId;
					scope.history.sessions = mergeAgentSessions(storedSessions);
					apply();
					agentSessionService.openSession(nodeId, session.executionId, target || 'provider-ide', mode || 'native', fallbackPolicy || 'provider-cli').then(function(result) {
						openStates[session.executionId] = {
							opening: false,
							openResult: result,
							openFallback: result && result.opened === false
						};
						scope.history.openingExecutionId = null;
						scope.history.sessions = mergeAgentSessions(storedSessions);
						apply();
					}, function(error) {
						openStates[session.executionId] = { opening: false, openError: error && error.message || String(error) };
						scope.history.openingExecutionId = null;
						scope.history.sessions = mergeAgentSessions(storedSessions);
						apply();
					});
				}

				scope.openSession = function(session) { openNative(session); };
				scope.retrySessionOpen = function(session) { openNative(session); };
				scope.openSessionFallback = function(session, target) {
					if (target === 'infinite-map') {
						document.dispatchEvent(new CustomEvent('agent-session-detail-open', {
							detail: { session: session, source: 'history-fallback' }
						}));
						return;
					}
					openNative(session, target, 'fallback-only', target === 'provider-cli' ? 'provider-cli' : 'infinite-map-detail');
				};
				scope.loadMoreSessions = function() {
					if (!scope.history.nextCursor || scope.history.loading) return;
					scope.history.loading = true;
					agentSessionService.queryHistoryPage(scope.history.nodeId, scope.history.nextCursor).then(function(page) {
						scope.history.loading = false;
						storedSessions = storedSessions.concat(page.sessions || []);
						scope.history.sessions = mergeAgentSessions(storedSessions);
						scope.history.total = scope.history.sessions.length;
						scope.history.nextCursor = page.nextCursor || null;
					}, function(error) {
						scope.history.loading = false;
						scope.history.error = error.message || String(error);
					});
				};
				scope.copySessionId = function(session) {
					var value = session && session.session && session.session.sessionId;
					if (!value) return;
					if (navigator.clipboard && navigator.clipboard.writeText) {
						navigator.clipboard.writeText(value);
					}
					scope.history.copiedExecutionId = session.executionId;
				};
				scope.$on('$destroy', function() {
                    document.removeEventListener('agent-session-history-open', open);
					document.removeEventListener('agent-session-history-close', close);
				});
				scope.$on('agent-session-live-detail', function() {
					if (!scope.history.visible) return;
					scope.history.sessions = mergeAgentSessions(storedSessions);
					scope.history.total = scope.history.sessions.length;
				});
				scope.$on('mcp-connection-state', function(_event, connection) {
					if (connection.state === 'ready' && scope.history.visible && scope.history.error) {
						loadHistory();
					}
				});
            }
        };
    }
]);
