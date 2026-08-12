angular.module('kityminderEditor').directive('agentSessionHistory', [
    'agentSessionService',
    function(agentSessionService) {
        return {
            restrict: 'A',
            templateUrl: 'ui/directive/agentSessionHistory/agentSessionHistory.html',
            link: function(scope) {
                scope.history = { visible: false, loading: false, sessions: [], total: 0 };

                function apply() {
                    if (!scope.$$phase && !scope.$root.$$phase) scope.$apply();
                }

				function open(event) {
                    var detail = event.detail || {};
                    if (!detail.nodeId) return;
                    scope.history = {
                        visible: true,
                        loading: true,
                        nodeId: detail.nodeId,
                        sessions: [],
                        total: 0,
                        error: null
                    };
                    apply();
					loadHistory();
				}

				function loadHistory() {
					if (!scope.history.visible || !scope.history.nodeId) return;
					scope.history.loading = true;
					agentSessionService.queryHistory(scope.history.nodeId).then(function(page) {
                        scope.history.loading = false;
                        scope.history.sessions = page.sessions || [];
                        scope.history.total = page.total || 0;
                        scope.history.orphan = page.orphan === true;
						scope.history.nextCursor = page.nextCursor || null;
                    }, function(error) {
                        scope.history.loading = false;
                        scope.history.error = error.message || String(error);
					});
				}

                document.addEventListener('agent-session-history-open', open);
                scope.closeHistory = function() {
                    scope.history.visible = false;
                };
                scope.openSession = function(session) {
					agentSessionService.openSession(session.nodeId || scope.history.nodeId, session.executionId, 'infinite-map');
                };
				scope.loadMoreSessions = function() {
					if (!scope.history.nextCursor || scope.history.loading) return;
					scope.history.loading = true;
					agentSessionService.queryHistoryPage(scope.history.nodeId, scope.history.nextCursor).then(function(page) {
						scope.history.loading = false;
						scope.history.sessions = scope.history.sessions.concat(page.sessions || []);
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
