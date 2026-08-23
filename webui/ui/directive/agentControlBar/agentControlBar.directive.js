angular.module('kityminderEditor').directive('agentControlBar', [
	'agentSessionService',
	'agentSessionI18n',
	function(agentSessionService, agentSessionI18n) {
		return {
			restrict: 'A',
			replace: true,
			templateUrl: 'ui/directive/agentControlBar/agentControlBar.html',
				link: function(scope, element) {
					var AGENT_ACTION_TIMEOUT_MS = 30000;
					var modelLoadProviderId = null;
					var agentActionSequence = 0;
					var agentActionTimeoutId = null;
					var retryAgentAction = null;
					var controlBarElement = element && element[0];
				scope.agentControl = {
					providers: [],
					models: [],
					efforts: [],
					permissionModes: [],
					input: '',
					busy: true,
					document: {},
					error: null,
					installCandidate: null,
					installation: null,
					authCandidate: null,
					permissionModeCandidate: null,
					inputRequest: null,
					action: { phase: 'idle', kind: null, requestId: 0 },
					mcpConnection: { state: 'connecting', attempt: 0, retryable: true, busy: false },
					collapsed: false,
					providerMenuOpen: false,
					permissionMenuOpen: false,
						configMenuOpen: false
					};

					function closeTransientSurfaces() {
						var changed = !!(
							scope.agentControl.providerMenuOpen ||
							scope.agentControl.permissionMenuOpen ||
							scope.agentControl.configMenuOpen ||
							scope.agentControl.installCandidate ||
							scope.agentControl.authCandidate ||
							scope.agentControl.permissionModeCandidate
						);
						scope.agentControl.providerMenuOpen = false;
						scope.agentControl.permissionMenuOpen = false;
						scope.agentControl.configMenuOpen = false;
						scope.agentControl.installCandidate = null;
						scope.agentControl.authCandidate = null;
						scope.agentControl.permissionModeCandidate = null;
						return changed;
					}

					function isMarkedAgentControlSurface(candidate) {
						return !!(candidate && candidate.getAttribute &&
							candidate.getAttribute('data-agent-control-surface') !== null);
					}

					function isAgentControlSurface(event) {
						var target = event && event.target;
						var path = event && typeof event.composedPath === 'function' ? event.composedPath() : [];
						for (var index = 0; index < path.length; index += 1) {
							var pathElement = path[index];
							if (pathElement === controlBarElement || isMarkedAgentControlSurface(pathElement)) {
								return true;
							}
						}
						if (!target) return false;
						if (controlBarElement && controlBarElement.contains && controlBarElement.contains(target)) {
							return true;
						}
						var candidate = target.nodeType === 1 ? target : target.parentNode;
						while (candidate && candidate !== document) {
							if (candidate === controlBarElement || isMarkedAgentControlSurface(candidate)) {
								return true;
							}
							candidate = candidate.parentNode;
						}
						return false;
					}

					function handleDocumentClick(event) {
						if (isAgentControlSurface(event)) return;
						var changed = closeTransientSurfaces();
						if (!scope.agentControl.collapsed) {
							scope.agentControl.collapsed = true;
							changed = true;
						}
						if (changed && scope.$evalAsync) scope.$evalAsync(function() {});
					}

					if (document.addEventListener) {
						document.addEventListener('click', handleDocumentClick);
					}

				function statusLabel(provider) {
					return agentSessionI18n.t(provider.installState || 'unavailable');
				}

				function selectedProvider() {
					return scope.agentControl.providers.find(function(provider) {
						return provider.id === scope.agentControl.providerId;
					});
				}

				function selectDefaults() {
					var selected = scope.agentControl.providers.find(function(provider) {
						return provider.id === scope.agentControl.providerId;
					});
					if (!selected) {
						selected = scope.agentControl.providers.find(function(provider) {
							return provider.installState === 'ready' || provider.installState === 'installed_inactive';
						}) || scope.agentControl.providers[0];
						scope.agentControl.providerId = selected && selected.id;
					}
					if (selected && selected.models && selected.models.length) {
						setModels(selected.models);
					}
					setPermissionModes(selected && selected.permissionModes || []);
					ensureSelectedProviderModels(selected);
				}

				function ensureSelectedProviderModels(provider) {
					if (!provider || scope.agentControl.models.length || scope.agentControl.modelId ||
						provider.installState === 'missing' || provider.installState === 'auth_required' ||
						provider.installState === 'failed' || provider.installState === 'incompatible' ||
						modelLoadProviderId === provider.id) {
						return;
					}
					modelLoadProviderId = provider.id;
					scope.agentControl.busy = true;
					agentSessionService.listModels(provider.id).then(function(result) {
						modelLoadProviderId = null;
						scope.agentControl.busy = false;
						scope.agentControl.error = null;
						updateProviderDescriptor(result.descriptor);
						setPermissionModes(result.permissionModes || result.descriptor && result.descriptor.permissionModes || []);
						if (result.descriptor && result.descriptor.installState === 'auth_required') {
							scope.agentControl.authCandidate = result.descriptor;
							setModels([]);
							return;
						}
						setModels(result.models || result.descriptor && result.descriptor.models || []);
					}, function(error) {
						modelLoadProviderId = null;
						scope.agentControl.busy = false;
						scope.agentControl.error = error && error.message || String(error);
					});
				}

				function setModels(models) {
					scope.agentControl.models = models || [];
					var selected = scope.agentControl.models.find(function(model) {
						return model.id === scope.agentControl.modelId;
					});
					if (!selected) {
						selected = scope.agentControl.models[0];
						scope.agentControl.modelId = selected && selected.id;
					}
					setEfforts(selected);
				}

				function setEfforts(model) {
					scope.agentControl.efforts = model && model.effortOptions || [];
					var valid = scope.agentControl.efforts.some(function(effort) {
						return effort.id === scope.agentControl.effort;
					});
					if (!valid) {
						scope.agentControl.effort = model && model.defaultEffort ||
							(scope.agentControl.efforts[0] && scope.agentControl.efforts[0].id);
					}
				}

				function setPermissionModes(modes) {
					scope.agentControl.permissionModes = (modes || []).filter(function(mode) {
						return mode && mode.id && mode.support !== 'unsupported';
					});
					var selected = scope.agentControl.permissionModes.find(function(mode) {
						return mode.id === scope.agentControl.permissionModeId;
					});
					if (!selected) {
						selected = scope.agentControl.permissionModes.find(function(mode) {
							return mode.isDefault === true;
						}) || scope.agentControl.permissionModes[0];
						scope.agentControl.permissionModeId = selected && selected.id;
					}
				}

				function updateProviderDescriptor(descriptor) {
					if (!descriptor) return;
					var index = scope.agentControl.providers.findIndex(function(provider) {
						return provider.id === descriptor.id;
					});
					if (index >= 0) {
						scope.agentControl.providers[index] = descriptor;
					}
				}

				function applySnapshot(value) {
					value = value || {};
					scope.agentControl.providers = value.providers || scope.agentControl.providers;
					scope.agentControl.session = agentSessionService.normalizeSession(value.session);
					scope.agentControl.document = value.document || scope.agentControl.document;
					scope.agentControl.mcpConnection = Object.assign(
						{},
						scope.agentControl.mcpConnection,
						value.mcpConnection || {}
					);
					if (value.session) {
						scope.agentControl.providerId = value.session.session.provider;
						scope.agentControl.modelId = value.session.requestedConfig && value.session.requestedConfig.modelId || value.session.session.modelId;
						scope.agentControl.effort = value.session.requestedConfig && value.session.requestedConfig.effort || value.session.session.effort;
						scope.agentControl.permissionModeId = value.session.requestedConfig && value.session.requestedConfig.permissionModeId ||
							value.session.effectiveConfig && value.session.effectiveConfig.permissionModeId ||
							value.session.session.permissionModeId;
					}
					selectDefaults();
				}

				function complete(promise, onSuccess) {
					promise.then(function(result) {
						scope.agentControl.busy = false;
						if (scope.agentControl.error === agentSessionI18n.t('mcpOperationFailed')) {
							scope.agentControl.error = agentSessionI18n.t('mcpReconnectedRetry');
						}
						if (onSuccess) onSuccess(result);
					}, function(error) {
						scope.agentControl.busy = false;
						scope.agentControl.error = error && error.message || String(error);
					});
				}

				scope.providerOptionLabel = function(provider) {
					if (provider.installState === 'ready') {
						return provider.displayName;
					}
					return provider.displayName + ' · ' + statusLabel(provider);
				};

				scope.selectedProviderLabel = function() {
					var provider = selectedProvider();
					return provider ? provider.displayName : agentSessionI18n.t('switchProvider');
				};

				scope.selectedModelLabel = function() {
					var model = scope.agentControl.models.find(function(candidate) {
						return candidate.id === scope.agentControl.modelId;
					});
					return model ? model.label : agentSessionI18n.t('defaultModel');
				};

				scope.selectedEffortLabel = function() {
					var effort = scope.agentControl.efforts.find(function(candidate) {
						return candidate.id === scope.agentControl.effort;
					});
					return effort && effort.label || '';
				};

				scope.configurationLabel = function() {
					var effort = scope.selectedEffortLabel();
					return scope.selectedModelLabel() + (effort ? ' · ' + effort : '');
				};

				scope.selectedPermissionMode = function() {
					return scope.agentControl.permissionModes.find(function(mode) {
						return mode.id === scope.agentControl.permissionModeId;
					});
				};

				scope.selectedPermissionModeLabel = function() {
					var mode = scope.selectedPermissionMode();
					return mode ? mode.label : agentSessionI18n.t('toolPermissions');
				};

				function activeSessionProviderId() {
					return scope.agentControl.session && scope.agentControl.session.session &&
						scope.agentControl.session.session.provider;
				}

				function usesSelectedSessionProvider() {
					var providerId = activeSessionProviderId();
					return !providerId || providerId === scope.agentControl.providerId;
				}

				scope.permissionModeDescription = function(mode) {
					if (!mode) return '';
					var semantics = mode.semantics || {};
					if (semantics.workspaceAccess === 'read-only') {
						return agentSessionI18n.t('permissionReadOnlyDescription');
					}
					if (semantics.workspaceAccess === 'full-access') {
						return agentSessionI18n.t('permissionFullAccessDescription');
					}
					if (semantics.approvals === 'provider-reviewed') {
						return agentSessionI18n.t('permissionAutoReviewDescription');
					}
					if (semantics.approvals === 'interactive') {
						return agentSessionI18n.t('permissionAskDescription');
					}
					var description = String(mode.description || '').trim().replace(/^:+/, '');
					return description.length > 56 ? description.slice(0, 55) + '…' : description;
				};

					scope.toggleCollapse = function() {
						closeTransientSurfaces();
						scope.agentControl.collapsed = !scope.agentControl.collapsed;
					};

				scope.toggleProviderMenu = function() {
					scope.agentControl.permissionMenuOpen = false;
					scope.agentControl.configMenuOpen = false;
					scope.agentControl.providerMenuOpen = !scope.agentControl.providerMenuOpen;
				};

				scope.toggleConfigMenu = function() {
					scope.agentControl.providerMenuOpen = false;
					scope.agentControl.permissionMenuOpen = false;
					scope.agentControl.configMenuOpen = !scope.agentControl.configMenuOpen;
				};

				scope.togglePermissionMenu = function() {
					scope.agentControl.providerMenuOpen = false;
					scope.agentControl.configMenuOpen = false;
					scope.agentControl.permissionMenuOpen = !scope.agentControl.permissionMenuOpen;
				};

				scope.selectProviderFromMenu = function(provider) {
					scope.agentControl.providerId = provider.id;
					scope.agentControl.providerMenuOpen = false;
					scope.providerChanged();
				};

				scope.selectModelFromMenu = function(model) {
					scope.agentControl.modelId = model.id;
					scope.agentControl.configMenuOpen = false;
					scope.modelChanged();
				};

				scope.selectEffortFromMenu = function(effort) {
					scope.agentControl.effort = effort.id;
					scope.agentControl.configMenuOpen = false;
				};

				scope.selectPermissionFromMenu = function(mode) {
					scope.agentControl.permissionMenuOpen = false;
					if (!mode || mode.support === 'unsupported') return;
					if (mode.requiresConfirmation || mode.risk === 'elevated') {
						scope.agentControl.permissionModeCandidate = mode;
						return;
					}
					scope.agentControl.permissionModeId = mode.id;
				};

				scope.confirmPermissionMode = function() {
					var candidate = scope.agentControl.permissionModeCandidate;
					if (!candidate) return;
					scope.agentControl.permissionModeId = candidate.id;
					scope.agentControl.permissionModeCandidate = null;
				};

				scope.cancelPermissionMode = function() {
					scope.agentControl.permissionModeCandidate = null;
				};

				scope.selectedProviderNeedsInstall = function() {
					var provider = selectedProvider();
					return !!provider && provider.installState === 'missing' && !scope.agentControl.installation;
				};

				scope.requestSelectedProviderInstall = function() {
					var provider = selectedProvider();
					if (provider && provider.installState === 'missing') {
						scope.agentControl.installCandidate = provider;
					}
				};

				scope.providerChanged = function() {
					var provider = selectedProvider();
					scope.agentControl.providerMenuOpen = false;
					scope.agentControl.permissionMenuOpen = false;
					scope.agentControl.configMenuOpen = false;
					scope.agentControl.permissionModeCandidate = null;
					modelLoadProviderId = null;
					scope.agentControl.modelId = null;
					scope.agentControl.effort = null;
					scope.agentControl.models = [];
					scope.agentControl.efforts = [];
					scope.agentControl.permissionModes = [];
					scope.agentControl.permissionModeId = null;
					scope.agentControl.error = null;
					if (!provider) return;
					if (provider.installState === 'missing') {
						scope.agentControl.installCandidate = provider;
						return;
					}
					if (provider.installState === 'auth_required') {
						scope.agentControl.authCandidate = provider;
						return;
					}
					setPermissionModes(provider.permissionModes || []);
					if (provider.models && provider.models.length) {
						setModels(provider.models);
						return;
					}
					ensureSelectedProviderModels(provider);
				};

				scope.modelChanged = function() {
					var model = scope.agentControl.models.find(function(candidate) {
						return candidate.id === scope.agentControl.modelId;
					});
					setEfforts(model);
				};

				scope.confirmProviderInstall = function() {
					var provider = scope.agentControl.installCandidate;
					if (!provider) return;
					startProviderInstall(provider);
				};

				scope.cancelProviderInstall = function() {
					scope.agentControl.installCandidate = null;
				};

				function startProviderInstall(provider) {
					scope.agentControl.installCandidate = null;
					scope.agentControl.installation = {
						provider: provider,
						phase: 'opening',
						error: null,
						descriptor: null
					};
					agentSessionService.installProvider(provider.id).then(function(result) {
						var installation = result && result.installation || {};
						scope.agentControl.installation.phase = 'completed';
						scope.agentControl.installation.descriptor = installation.descriptor || null;
						if (installation.descriptor && installation.descriptor.models) {
							setModels(installation.descriptor.models);
						}
						if (installation.descriptor) {
							setPermissionModes(installation.descriptor.permissionModes || []);
						}
						agentSessionService.discoverProviders().then(applySnapshot);
					}, function(error) {
						if (!scope.agentControl.installation) return;
						scope.agentControl.installation.phase = 'failed';
						scope.agentControl.installation.error = error && error.message || String(error);
					});
				}

				scope.retryProviderInstall = function() {
					var installation = scope.agentControl.installation;
					if (!installation || installation.phase !== 'failed') return;
					startProviderInstall(installation.provider);
				};

				scope.closeProviderInstallation = function() {
					var installation = scope.agentControl.installation;
					if (!installation || scope.isProviderInstalling()) return;
					scope.agentControl.installation = null;
					if (installation.descriptor && installation.descriptor.installState === 'auth_required') {
						scope.agentControl.authCandidate = installation.descriptor;
					}
				};

				scope.isProviderInstalling = function() {
					var phase = scope.agentControl.installation && scope.agentControl.installation.phase;
					return phase === 'opening' || phase === 'waiting' || phase === 'verifying';
				};

				scope.providerInstallProgressValue = function() {
					var phase = scope.agentControl.installation && scope.agentControl.installation.phase;
					return { opening: 1, waiting: 2, verifying: 3, completed: 3 }[phase] || 1;
				};

				scope.providerInstallStatusLabel = function() {
					var phase = scope.agentControl.installation && scope.agentControl.installation.phase;
					return agentSessionI18n.t({
						opening: 'installOpening',
						waiting: 'installWaiting',
						verifying: 'installVerifying',
						completed: 'installCompleted',
						failed: 'installFailed'
					}[phase] || 'installOpening');
				};
				scope.confirmProviderAuth = function() {
					var provider = scope.agentControl.authCandidate;
					if (!provider) return;
					scope.agentControl.busy = true;
					complete(agentSessionService.authenticateProvider(provider.id), function() {
						scope.agentControl.authCandidate = null;
						scope.agentControl.busy = true;
						complete(agentSessionService.discoverProviders(), applySnapshot);
					});
				};
				scope.cancelProviderAuth = function() {
					scope.agentControl.authCandidate = null;
				};

				function createIdempotencyKey() {
					return window.crypto && window.crypto.randomUUID
						? window.crypto.randomUUID()
						: 'submission-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
				}

				function submissionPayload(kind) {
					var payload = {
						providerId: kind === 'append'
							? activeSessionProviderId() || scope.agentControl.providerId
							: scope.agentControl.providerId,
						modelId: scope.agentControl.modelId,
						effort: scope.agentControl.effort,
						permissionModeId: scope.agentControl.permissionModeId,
						input: scope.agentControl.input || '',
						nodeId: window.infiniteMapSelectedNodeId || undefined
					};
					if (kind === 'append') {
						payload.expectedTurnId = scope.agentControl.session.activeTurnId;
					}
					var fingerprint = JSON.stringify(payload);
					if (retryAgentAction && retryAgentAction.kind === kind && retryAgentAction.fingerprint === fingerprint) {
						return Object.assign({}, retryAgentAction.payload);
					}
					payload.idempotencyKey = createIdempotencyKey();
					return payload;
				}

				function clearAgentActionTimeout() {
					if (agentActionTimeoutId !== null) {
						clearTimeout(agentActionTimeoutId);
						agentActionTimeoutId = null;
					}
				}

				function beginAgentAction(kind, retryValue) {
					clearAgentActionTimeout();
					agentActionSequence += 1;
					scope.agentControl.action = {
						phase: kind === 'interrupt' ? 'interrupting' : 'sending',
						kind: kind,
						requestId: agentActionSequence
					};
					retryAgentAction = retryValue;
					scope.agentControl.busy = true;
					scope.agentControl.error = null;
					var requestId = agentActionSequence;
					agentActionTimeoutId = setTimeout(function() {
						if (scope.agentControl.action.requestId !== requestId || !scope.isAgentActionPending()) return;
						agentActionTimeoutId = null;
						scope.agentControl.busy = false;
						scope.agentControl.action.phase = 'timed_out';
						scope.agentControl.error = agentSessionI18n.t('requestTimedOut');
						if (scope.$evalAsync) scope.$evalAsync(function() {});
					}, AGENT_ACTION_TIMEOUT_MS);
					return requestId;
				}

				function isCurrentAgentAction(requestId) {
					return scope.agentControl.action.requestId === requestId && scope.isAgentActionPending();
				}

				function completeAgentAction(requestId, result, onSuccess) {
					if (!isCurrentAgentAction(requestId)) return;
					clearAgentActionTimeout();
					scope.agentControl.busy = false;
					scope.agentControl.action.phase = 'idle';
					scope.agentControl.action.kind = null;
					retryAgentAction = null;
					scope.agentControl.error = null;
					onSuccess(result);
				}

				function failAgentAction(requestId, error) {
					if (!isCurrentAgentAction(requestId)) return;
					clearAgentActionTimeout();
					scope.agentControl.busy = false;
					scope.agentControl.action.phase = 'failed';
					scope.agentControl.error = error && error.message || String(error);
				}

				scope.sendAgentSession = function() {
					if (!scope.canSendAgentSession()) return;
					var payload = submissionPayload('send');
					var requestId = beginAgentAction('send', {
						kind: 'send',
						fingerprint: JSON.stringify(Object.assign({}, payload, { idempotencyKey: undefined })),
						payload: payload
					});
					agentSessionService.send(payload).then(function(result) {
						completeAgentAction(requestId, result, function(value) {
							scope.agentControl.session = agentSessionService.normalizeSession(value.session);
							scope.agentControl.permissionModeId = scope.agentControl.session.requestedConfig &&
								scope.agentControl.session.requestedConfig.permissionModeId || scope.agentControl.permissionModeId;
							scope.agentControl.input = '';
						});
					}, function(error) {
						failAgentAction(requestId, error);
					});
				};

				scope.appendAgentSession = function() {
					if (!scope.canAppendAgentSession()) return;
					var payload = submissionPayload('append');
					var requestId = beginAgentAction('append', {
						kind: 'append',
						fingerprint: JSON.stringify(Object.assign({}, payload, { idempotencyKey: undefined })),
						payload: payload
					});
					agentSessionService.append(payload).then(function(result) {
						completeAgentAction(requestId, result, function(value) {
							scope.agentControl.session = agentSessionService.normalizeSession(value.session);
							scope.agentControl.permissionModeId = scope.agentControl.session.requestedConfig &&
								scope.agentControl.session.requestedConfig.permissionModeId || scope.agentControl.permissionModeId;
							scope.agentControl.input = '';
						});
					}, function(error) {
						failAgentAction(requestId, error);
					});
				};

				scope.interruptAgentSession = function() {
					if (!scope.canInterruptAgentSession()) return;
					var turnId = scope.agentControl.session.activeTurnId;
					var requestId = beginAgentAction('interrupt', { kind: 'interrupt', turnId: turnId });
					agentSessionService.interrupt(turnId).then(function(result) {
						completeAgentAction(requestId, result, function(value) {
							scope.agentControl.session = agentSessionService.normalizeSession(value.session);
						});
					}, function(error) {
						failAgentAction(requestId, error);
					});
				};

				scope.retryAgentAction = function() {
					if (!scope.canRetryAgentAction()) return;
					if (retryAgentAction.kind === 'interrupt') {
						scope.interruptAgentSession();
					} else if (retryAgentAction.kind === 'append') {
						scope.appendAgentSession();
					} else {
						scope.sendAgentSession();
					}
				};

				scope.mcpConnectionLabel = function() {
					var state = scope.agentControl.mcpConnection.state;
					return agentSessionI18n.t({
						ready: 'mcpReady',
						connecting: 'mcpConnecting',
						reconnecting: 'mcpReconnecting',
						unavailable: 'mcpUnavailable'
					}[state] || 'mcpUnavailable');
				};

				scope.reconnectMcp = function() {
					var connection = scope.agentControl.mcpConnection;
					if (connection.busy || connection.state === 'ready') return;
					connection.busy = true;
					connection.state = 'reconnecting';
					agentSessionService.reconnectMcp().then(function(result) {
						scope.agentControl.mcpConnection = Object.assign(
							{},
							connection,
							result.connection || { state: 'ready' },
							{ busy: false }
						);
						if (scope.agentControl.error === agentSessionI18n.t('mcpOperationFailed')) {
							scope.agentControl.error = agentSessionI18n.t('mcpReconnectedRetry');
						}
					}, function(error) {
						connection.busy = false;
						connection.state = 'unavailable';
						scope.agentControl.error = error && error.message || String(error);
					});
				};

				scope.resolveAgentInput = function(decision) {
					var request = scope.agentControl.inputRequest;
					if (!request || request.resolving) return;
					request.resolving = true;
					agentSessionService.resolveInput(request.requestId, decision, request.value).then(function() {
						scope.agentControl.inputRequest = null;
					}, function(error) {
						request.resolving = false;
						scope.agentControl.error = error && error.message || String(error);
					});
				};

				scope.canSendAgentSession = function() {
					return !!(!scope.agentControl.busy && !scope.agentControl.document.dirty &&
						!scope.agentControl.document.conflict && scope.agentControl.providerId &&
						scope.agentControl.modelId && scope.agentControl.permissionModeId &&
						!(scope.agentControl.session && scope.agentControl.session.activeTurnId));
				};

				scope.canAppendAgentSession = function() {
					return !!(!scope.agentControl.busy && !scope.agentControl.document.dirty &&
						!scope.agentControl.document.conflict && scope.agentControl.session &&
						!scope.agentControl.session.activeTurnId && usesSelectedSessionProvider() && scope.agentControl.modelId &&
						scope.agentControl.permissionModeId);
				};

				scope.canInterruptAgentSession = function() {
					return !!(!scope.agentControl.busy && scope.agentControl.session && scope.agentControl.session.activeTurnId);
				};

				scope.isAgentActionPending = function() {
					var phase = scope.agentControl.action.phase;
					return phase === 'sending' || phase === 'interrupting';
				};

				scope.agentActionFeedbackState = function() {
					if (scope.isAgentActionPending()) return scope.agentControl.action.phase;
					if (scope.agentControl.session && scope.agentControl.session.activeTurnId) return 'running';
					return 'idle';
				};

				scope.agentActionStatusLabel = function() {
					return agentSessionI18n.t({
						sending: 'sending',
						interrupting: 'interrupting',
						running: 'active'
					}[scope.agentActionFeedbackState()] || 'idle');
				};

				scope.canRetryAgentAction = function() {
					var phase = scope.agentControl.action.phase;
					if (!retryAgentAction || (phase !== 'failed' && phase !== 'timed_out')) return false;
					if (retryAgentAction.kind === 'interrupt') {
						return !!(scope.canInterruptAgentSession() &&
							scope.agentControl.session.activeTurnId === retryAgentAction.turnId);
					}
					if (retryAgentAction.kind === 'append') {
						return !!(scope.canAppendAgentSession() &&
							scope.agentControl.session.activeTurnId === retryAgentAction.payload.expectedTurnId);
					}
					return scope.canSendAgentSession();
				};

				scope.getPrimaryActionState = function() {
					if (scope.agentControl.session && scope.agentControl.session.activeTurnId) {
						return 'interrupt';
					}
					if (scope.agentControl.session && usesSelectedSessionProvider()) {
						return 'append';
					}
					return 'send';
				};

				scope.canPerformPrimaryAction = function() {
					var state = scope.getPrimaryActionState();
					if (state === 'interrupt') return scope.canInterruptAgentSession();
					if (state === 'append') return scope.canAppendAgentSession();
					return scope.canSendAgentSession();
				};

				scope.handlePrimaryAction = function() {
					var state = scope.getPrimaryActionState();
					if (state === 'interrupt') {
						scope.interruptAgentSession();
						return;
					}
					if (state === 'append') {
						scope.appendAgentSession();
						return;
					}
					scope.sendAgentSession();
				};

				scope.primaryActionLabel = function() {
					if (scope.agentControl.action.phase === 'interrupting') return agentSessionI18n.t('interrupting');
					if (scope.agentControl.action.phase === 'sending') return agentSessionI18n.t('sending');
					var state = scope.getPrimaryActionState();
					if (state === 'interrupt') return agentSessionI18n.t('interrupt');
					if (state === 'append') return agentSessionI18n.t('append');
					return agentSessionI18n.t('send');
				};

					scope.handleComposerKeydown = function(event) {
						if (!event || event.key !== 'Enter' || event.shiftKey || event.isComposing) return;
						event.preventDefault();
						if (scope.canPerformPrimaryAction()) scope.handlePrimaryAction();
					};

					function sessionEventStatus(payload) {
						return payload && (payload.status || payload.turn && payload.turn.status);
					}

					function sessionEventError(payload) {
						var error = payload && (payload.error || payload.turn && payload.turn.error);
						if (!error) return '';
						if (typeof error === 'string') return error;
						return error.message || error.code || String(error);
					}

					function applyRuntimeFailure(status, payload) {
						if (status !== 'failed' && status !== 'disconnected' && status !== 'conflict') return;
						var message = sessionEventError(payload);
						if (message || !scope.agentControl.error) {
							scope.agentControl.error = message || agentSessionI18n.t('failedState');
						}
					}

				scope.$on('agent-session-snapshot', function(_event, value) {
					applySnapshot(value);
				});
					scope.$on('agent-session-event', function(_event, value) {
						if (!scope.agentControl.session || value.executionId !== scope.agentControl.session.executionId) return;
						if (value.type === 'session.input.required' && value.payload && value.payload.requestId) {
							scope.agentControl.inputRequest = Object.assign({ value: '', resolving: false }, value.payload);
						}
						if (value.type === 'session.state.changed' && value.payload) {
							var status = sessionEventStatus(value.payload);
							if (status) scope.agentControl.session.status = status;
							if (Object.prototype.hasOwnProperty.call(value.payload, 'activeTurnId')) {
								scope.agentControl.session.activeTurnId = value.payload.activeTurnId;
							}
							applyRuntimeFailure(status, value.payload);
						}
						if (value.type === 'session.completed') {
							var completedStatus = sessionEventStatus(value.payload) || scope.agentControl.session.status;
							scope.agentControl.session.activeTurnId = null;
							scope.agentControl.session.status = completedStatus === 'failed' || completedStatus === 'interrupted'
								? completedStatus
								: 'idle';
							applyRuntimeFailure(completedStatus, value.payload);
						}
				});
				scope.$on('agent-provider-install-progress', function(_event, value) {
					var installation = scope.agentControl.installation;
					if (!installation || value.providerId !== installation.provider.id) return;
					installation.phase = value.phase;
					if (value.error) installation.error = value.error.message;
				});
				scope.$on('mcp-connection-state', function(_event, value) {
					scope.agentControl.mcpConnection = Object.assign(
						{},
						scope.agentControl.mcpConnection,
						value,
						{ busy: false }
					);
					if (value.state === 'ready' && scope.agentControl.error &&
						scope.agentControl.error === agentSessionI18n.t('mcpOperationFailed')) {
						scope.agentControl.error = agentSessionI18n.t('mcpReconnectedRetry');
					}
				});
					scope.$on('$destroy', function() {
						agentActionSequence += 1;
						clearAgentActionTimeout();
						if (document.removeEventListener) {
							document.removeEventListener('click', handleDocumentClick);
						}
					});

				applySnapshot(agentSessionService.getSnapshot());
				complete(agentSessionService.discoverProviders(), applySnapshot);
			}
		};
	}
]);
