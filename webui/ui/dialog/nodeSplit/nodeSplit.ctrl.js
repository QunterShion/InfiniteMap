angular.module('kityminderEditor')
    .controller('nodeSplit.ctrl', function($scope, $uibModalInstance, isRoot, nodeText) {
        $scope.isRoot = isRoot;
        $scope.nodeText = nodeText;
        $scope.confirm = function() {
            $uibModalInstance.close();
        };
        $scope.cancel = function() {
            $uibModalInstance.dismiss('cancel');
        };
    });
