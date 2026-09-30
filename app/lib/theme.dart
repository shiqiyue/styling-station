/// 主题：复刻 web/style.css 的设计变量，保证新旧界面观感一致。
library;

import 'package:flutter/material.dart';

/// 设计变量（与 web/style.css `:root` 一一对应）。
abstract final class AppColors {
  static const bg = Color(0xFFF4F3F0);
  static const panel = Color(0xFFFFFFFF);
  static const text = Color(0xFF26221C);
  static const muted = Color(0xFF8D8577);
  static const line = Color(0xFFE6E2DA);
  static const accent = Color(0xFF0F766E);
  static const accentSoft = Color(0xFFE4F2F0);
  static const danger = Color(0xFFB91C1C);
  static const warn = Color(0xFFB45309);
}

const double kRadius = 12;

ThemeData buildAppTheme() {
  final base = ThemeData(
    useMaterial3: true,
    colorScheme: ColorScheme.fromSeed(
      seedColor: AppColors.accent,
      brightness: Brightness.light,
      surface: AppColors.panel,
      primary: AppColors.accent,
      error: AppColors.danger
    ),
    scaffoldBackgroundColor: AppColors.bg
  );
  return base.copyWith(
    textTheme: base.textTheme.apply(
      fontFamily: 'SourceHanSans',
      bodyColor: AppColors.text,
      displayColor: AppColors.text
    ),
    appBarTheme: const AppBarTheme(
      backgroundColor: AppColors.panel,
      foregroundColor: AppColors.text,
      elevation: 0,
      surfaceTintColor: Colors.transparent
    ),
    dividerTheme: const DividerThemeData(color: AppColors.line, thickness: 1, space: 1),
    filledButtonTheme: FilledButtonThemeData(
      style: FilledButton.styleFrom(
        backgroundColor: AppColors.accent,
        foregroundColor: Colors.white,
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(kRadius - 4))
      )
    ),
    outlinedButtonTheme: OutlinedButtonThemeData(
      style: OutlinedButton.styleFrom(
        foregroundColor: AppColors.text,
        side: const BorderSide(color: AppColors.line),
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(kRadius - 4))
      )
    ),
    textButtonTheme: TextButtonThemeData(
      style: TextButton.styleFrom(foregroundColor: AppColors.accent)
    ),
    inputDecorationTheme: InputDecorationTheme(
      filled: true,
      fillColor: AppColors.panel,
      isDense: true,
      hintStyle: const TextStyle(color: AppColors.muted),
      border: OutlineInputBorder(
        borderRadius: BorderRadius.circular(kRadius - 4),
        borderSide: const BorderSide(color: AppColors.line)
      ),
      enabledBorder: OutlineInputBorder(
        borderRadius: BorderRadius.circular(kRadius - 4),
        borderSide: const BorderSide(color: AppColors.line)
      ),
      focusedBorder: OutlineInputBorder(
        borderRadius: BorderRadius.circular(kRadius - 4),
        borderSide: const BorderSide(color: AppColors.accent)
      )
    ),
    dialogTheme: DialogThemeData(
      backgroundColor: AppColors.panel,
      surfaceTintColor: Colors.transparent,
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(kRadius))
    ),
    snackBarTheme: SnackBarThemeData(
      backgroundColor: AppColors.text,
      contentTextStyle: const TextStyle(color: Colors.white, fontFamily: 'SourceHanSans'),
      behavior: SnackBarBehavior.floating,
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(kRadius - 4))
    ),
    cardTheme: CardThemeData(
      color: AppColors.panel,
      surfaceTintColor: Colors.transparent,
      elevation: 0,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(kRadius),
        side: const BorderSide(color: AppColors.line)
      )
    ),
    chipTheme: base.chipTheme.copyWith(
      backgroundColor: AppColors.panel,
      side: const BorderSide(color: AppColors.line),
      labelStyle: const TextStyle(color: AppColors.text, fontFamily: 'SourceHanSans'),
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(999))
    ),
    progressIndicatorTheme: const ProgressIndicatorThemeData(color: AppColors.accent)
  );
}
