angular.module('kityminderEditor').directive('agentActivityOverview', [
	'agentSessionService',
	function(agentSessionService) {
		return {
			restrict: 'A',
			templateUrl: 'ui/directive/agentActivityOverview/agentActivityOverview.html',
			link: function(scope) {
				var ACTIVE_STATUSES = {
					allocated: true,
					starting: true,
					running: true,
					interrupting: true,
					disconnected: true
				};
				var refreshTimer = null;
				var storedSessions = [];
				scope.activity = { visible: false, loading: false, items: [], total: 0, error: null };

				function apply() {
					if (!scope.$$phase && !scope.$root.$$phase) scope.$apply();
				}

				function announceDrawerState(open, restoreFocus) {
					document.dispatchEvent(new CustomEvent('agent-session-drawer-state', {
						detail: { drawer: 'activity', open: open, restoreFocus: restoreFocus === true }
					}));
				}

				function focusDrawer() {
					window.setTimeout(function() {
						var drawer = document.getElementById('agent-activity-drawer');
						if (drawer && drawer.focus) drawer.focus();
					}, 0);
				}

				function nodeTitle(nodeId) {
					var title = nodeId;
					if (!window.minder || !window.minder.getRoot) return title;
					window.minder.getRoot().traverse(function(node) {
						if (node.getData('id') === nodeId) title = node.getText() || nodeId;
					});
					return title;
				}

				function merge(sessions) {
					var byExecution = {};
					var liveSessions = agentSessionService.listLiveAgentSessions
						? agentSessionService.listLiveAgentSessions()
						: [];
					(sessions || []).concat(liveSessions).filter(function(session) {
						return ACTIVE_STATUSES[session.status] === true;
					}).forEach(function(session) {
						var item = {
							nodeId: session.nodeId,
							nodeTitle: nodeTitle(session.nodeId) || session.title || session.executionId,
							executionId: session.executionId,
							status: session.status,
							provider: session.session && session.session.provider,
							modelId: session.session && session.session.modelId,
							updatedAt: session.updatedAt,
							session: session
						};
						byExecution[session.executionId] = item;
					});
				scope.activity.items = Object.keys(byExecution).map(function(key) { return byExecution[key]; }).sort(function(left, right) {
					return Date.parse(right.updatedAt || 0) - Date.parse(left.updatedAt || 0);
				});
				scope.activity.total = scope.activity.items.length;
			}

				function load(cursor, sessions) {
					agentSessionService.queryActivityPage(cursor, 100).then(function(page) {
						var collected = sessions.concat(page.sessions || []);
						if (page.nextCursor) {
							load(page.nextCursor, collected);
							return;
						}
						scope.activity.loading = false;
						scope.activity.error = null;
						storedSessions = collected;
						merge(storedSessions);
					}, function(error) {
						scope.activity.loading = false;
						scope.activity.error = error && error.message || String(error);
					});
				}

				function refresh() {
					if (!scope.activity.visible) return;
					scope.activity.loading = true;
					load(null, []);
				}

				function scheduleHistoryRefresh() {
					if (!scope.activity.visible) return;
					if (refreshTimer) window.clearTimeout(refreshTimer);
					refreshTimer = window.setTimeout(function() {
						refreshTimer = null;
						refresh();
					}, 60);
				}

				function refreshLiveSessions() {
					if (!scope.activity.visible) return;
					merge(storedSessions);
				}

				function open() {
					document.dispatchEvent(new CustomEvent('agent-session-history-close'));
					document.dispatchEvent(new CustomEvent('agent-session-detail-close'));
					scope.activity.visible = true;
					refresh();
					announceDrawerState(true);
					apply();
					focusDrawer();
				}

				function close(event) {
					if (!scope.activity.visible) return;
					scope.activity.visible = false;
					announceDrawerState(false, event && event.detail && event.detail.restoreFocus);
					apply();
				}

				document.addEventListener('agent-activity-open', open);
				document.addEventListener('agent-activity-close', close);
				scope.$on('agent-session-live-detail', function() {
					refreshLiveSessions();
				});
				scope.$on('agent-session-event', function(_event, value) {
					if (value.type === 'history.changed') scheduleHistoryRefresh();
				});
				scope.closeAgentActivity = function() {
					close({ detail: { restoreFocus: true } });
				};
				scope.openActivitySession = function(item) {
					document.dispatchEvent(new CustomEvent('agent-session-detail-open', {
						detail: { session: item.session, source: 'activity' }
					}));
				};
				scope.$on('$destroy', function() {
					if (refreshTimer) window.clearTimeout(refreshTimer);
					document.removeEventListener('agent-activity-open', open);
					document.removeEventListener('agent-activity-close', close);
				});
			}
		};
	}
]);
