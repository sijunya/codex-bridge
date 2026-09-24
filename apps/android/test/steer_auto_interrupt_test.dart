import 'package:flutter_test/flutter_test.dart';

import 'package:codex_bridge/data/models.dart';
import 'package:codex_bridge/data/workbench.dart';

import 'support.dart';

class MockRpcWorkbench extends Workbench {
  final List<Map<String, dynamic>> rpcCalls = [];

  MockRpcWorkbench() : super(MemoryStore()) {
    initialized = true;
    host = sampleHost;
    status = 'online';
    projectId = 'p-1';
    threadId = 't-1';
    projects = [
      {'id': 'p-1', 'name': 'Test Project'}
    ];
    threads = [
      {'id': 't-1', 'name': 'Current Conversation', 'project': 'p-1'}
    ];
  }

  @override
  Future<dynamic> rpc(String method, [dynamic params]) async {
    rpcCalls.add({'method': method, 'params': params});
    if (method == 'turn/interrupt') {
      // Simulate server settling to idle upon interrupt
      runtimeThreads.removeWhere((e) => e['id'] == threadId);
      notifyListeners();
    }
    return {};
  }
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  group('supportsSteer & isAgy capabilities', () {
    test('identifies AGY bridge correctly', () {
      final workbench = MockRpcWorkbench();
      workbench.info = {
        'codexVersion': 'agy-0.1.0',
        'capabilities': ['threads', 'streaming'],
      };
      expect(workbench.isAgy, isTrue);
      expect(workbench.supportsSteer, isFalse);
    });

    test('identifies Codex bridge with steer capability', () {
      final workbench = MockRpcWorkbench();
      workbench.info = {
        'codexVersion': '0.45.0',
        'capabilities': ['threads', 'steer'],
      };
      expect(workbench.isAgy, isFalse);
      expect(workbench.supportsSteer, isTrue);
    });

    test('identifies older Codex bridge by threads capability', () {
      final workbench = MockRpcWorkbench();
      workbench.info = {
        'codexVersion': '0.45.0',
        'capabilities': ['threads'],
      };
      expect(workbench.isAgy, isFalse);
      expect(workbench.supportsSteer, isTrue);
    });
  });

  group('Auto-interrupt when host does not support steer', () {
    test('AGY host: send while running interrupts first, then starts new turn in same thread', () async {
      final workbench = MockRpcWorkbench();
      workbench.info = {
        'codexVersion': 'agy-0.1.0',
        'capabilities': ['threads', 'streaming'],
      };
      workbench.runtimeThreads = [
        {'id': 't-1', 'state': 'running', 'turn': 'turn-123'}
      ];

      expect(workbench.running, isNotNull);

      await workbench.send('新问题', []);

      expect(workbench.rpcCalls.length, 2);
      expect(workbench.rpcCalls[0]['method'], 'turn/interrupt');
      expect(workbench.rpcCalls[0]['params']['threadId'], 't-1');
      expect(workbench.rpcCalls[0]['params']['turnId'], 'turn-123');

      expect(workbench.rpcCalls[1]['method'], 'turn/start');
      expect(workbench.rpcCalls[1]['params']['threadId'], 't-1');
      expect(workbench.rpcCalls[1]['params']['input'], [
        {'type': 'text', 'text': '新问题', 'text_elements': <dynamic>[]}
      ]);
    });

    test('Codex host: send while running uses turn/steer', () async {
      final workbench = MockRpcWorkbench();
      workbench.info = {
        'codexVersion': '0.45.0',
        'capabilities': ['threads', 'steer'],
      };
      workbench.runtimeThreads = [
        {'id': 't-1', 'state': 'running', 'turn': 'turn-456'}
      ];

      expect(workbench.running, isNotNull);

      await workbench.send('补充要求', []);

      expect(workbench.rpcCalls.length, 1);
      expect(workbench.rpcCalls[0]['method'], 'turn/steer');
      expect(workbench.rpcCalls[0]['params']['threadId'], 't-1');
      expect(workbench.rpcCalls[0]['params']['expectedTurnId'], 'turn-456');
    });
  });

  group('Composer hint rendering', () {
    test('hint resolves to 正在回复中… on AGY when running', () {
      final workbench = MockRpcWorkbench();
      workbench.info = {
        'codexVersion': 'agy-0.1.0',
        'capabilities': ['threads', 'streaming'],
      };
      workbench.runtimeThreads = [
        {'id': 't-1', 'state': 'running', 'turn': 'turn-123'}
      ];

      final hint = workbench.running != null
          ? (workbench.supportsSteer ? '补充指令，调整当前任务…' : '正在回复中…')
          : '描述任务，或提出问题…';

      expect(hint, '正在回复中…');
    });

    test('hint resolves to 补充指令，调整当前任务… on Codex when running', () {
      final workbench = MockRpcWorkbench();
      workbench.info = {
        'codexVersion': '0.45.0',
        'capabilities': ['threads', 'steer'],
      };
      workbench.runtimeThreads = [
        {'id': 't-1', 'state': 'running', 'turn': 'turn-123'}
      ];

      final hint = workbench.running != null
          ? (workbench.supportsSteer ? '补充指令，调整当前任务…' : '正在回复中…')
          : '描述任务，或提出问题…';

      expect(hint, '补充指令，调整当前任务…');
    });

    test('hint resolves to 描述任务，或提出问题… when idle', () {
      final workbench = MockRpcWorkbench();
      workbench.info = {
        'codexVersion': 'agy-0.1.0',
        'capabilities': ['threads', 'streaming'],
      };
      workbench.runtimeThreads = [];

      final hint = workbench.running != null
          ? (workbench.supportsSteer ? '补充指令，调整当前任务…' : '正在回复中…')
          : '描述任务，或提出问题…';

      expect(hint, '描述任务，或提出问题…');
    });
  });
}
