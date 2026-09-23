import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:codex_bridge/data/workbench.dart';
import 'package:codex_bridge/ui/chat.dart';

import 'support.dart';

void main() {
  testWidgets('chat history lazy loads latest messages and paginates upwards',
      (tester) async {
    final workbench = fixtureWorkbench();
    // Generate 60 messages
    final items = List.generate(
      60,
      (i) => {
        'id': 'msg-$i',
        'type': 'userMessage',
        'turnId': 'turn-$i',
        'content': [
          {'type': 'text', 'text': 'User query number $i'}
        ],
      },
    );
    workbench.timelines['task'] = items;
    workbench.threadId = 'task';

    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: ChatPane(workbench: workbench),
        ),
      ),
    );
    await tester.pumpAndSettle();

    // Initially items 35..59 are visible, 0..34 are not
    expect(find.text('User query number 59'), findsOneWidget);
    expect(find.text('User query number 0'), findsNothing);

    // Drag down (scroll upwards) - this triggers auto-load of earlier messages!
    await tester.drag(find.byType(ListView), const Offset(0, 500));
    await tester.pumpAndSettle();

    // After scrolling up, earlier messages (like query 30 or 25) are loaded!
    // And when dragged all the way up, all messages load and history start header appears
    for (int i = 0; i < 5; i++) {
      await tester.drag(find.byType(ListView), const Offset(0, 1000));
      await tester.pumpAndSettle();
    }

    expect(find.text('User query number 0'), findsOneWidget);
    expect(find.byKey(const ValueKey('history-start-header')), findsOneWidget);
    expect(find.text('已加载全部历史记录'), findsOneWidget);
  });
}
