/// 轻提示（SnackBar）：默认 3 秒自动消失；error 用危险色。
library;

import 'package:flutter/material.dart';

import '../theme.dart';

void showToast(BuildContext context, String message, {bool error = false}) {
  final messenger = ScaffoldMessenger.maybeOf(context);
  if (messenger == null) return;
  messenger
    ..hideCurrentSnackBar()
    ..showSnackBar(
      SnackBar(
        content: Text(message),
        duration: const Duration(seconds: 3),
        backgroundColor: error ? AppColors.danger : null
      )
    );
}
