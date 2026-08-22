angular.module('kityminderEditor').directive('agentSessionDetail', [
	'agentSessionService',
	function(agentSessionService) {
		return {
			restrict: 'A',
			templateUrl: 'ui/directive/agentSessionDetail/agentSessionDetail.html',
			link: function(scope) {
				var ACTIVE_STATUSES = {
					allocated: true,
					starting: true,
					running: true,
					interrupting: true,
					disconnected: true
				};
				scope.sessionDetail = { visible: false, session: null, events: [], live: false };

				function apply() {
					if (!scope.$$phase && !scope.$root.$$phase) scope.$apply();
				}

				function nodeTitle(nodeId) {
					var title = nodeId;
					if (!nodeId || !window.minder || !window.minder.getRoot) return title;
					window.minder.getRoot().traverse(function(node) {
						if (node.getData('id') === nodeId) title = node.getText() || nodeId;
					});
					return title;
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
					scope.sessionDetail.session = session;
					scope.sessionDetail.events = (live.events || []).slice();
					scope.sessionDetail.live = ACTIVE_STATUSES[session.status] === true;
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
					scope.sessionDetail.source = detail.source === 'activity' ? 'activity' : 'history';
					scope.sessionDetail.executionId = detail.session.executionId;
					hydrate(detail.session);
					apply();
					focusDetail();
				}

				function close(restoreFocus) {
					if (!scope.sessionDetail.visible) return;
					var executionId = scope.sessionDetail.executionId;
					scope.sessionDetail.visible = false;
					apply();
					if (!restoreFocus) return;
					window.setTimeout(function() {
						var trigger = document.querySelector('[data-execution-id="' + executionId + '"]');
						if (trigger && trigger.focus) trigger.focus();
					}, 0);
				}

				function closeFromEvent() { close(false); }

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
				scope.$on('agent-session-live-detail', function(_event, detail) {
					if (!scope.sessionDetail.visible || !detail || detail.executionId !== scope.sessionDetail.executionId) return;
					hydrate(scope.sessionDetail.session);
				});
				scope.$on('$destroy', function() {
					document.removeEventListener('agent-session-detail-open', open);
					document.removeEventListener('agent-session-detail-close', closeFromEvent);
					document.removeEventListener('keydown', handleEscape, true);
				});
			}
		};
	}
]);
