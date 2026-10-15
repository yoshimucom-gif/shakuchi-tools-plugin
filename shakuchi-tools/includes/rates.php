<?php
/**
 * 掛け率の定義・既定値・保存・画面。
 *
 * ★既定値はすべて暫定（2026-10 時点、監修者の確認待ち）。確定したら
 *   ここの既定値も直して版を上げる（入れてあるサイトの保存値は管理画面で直す）。
 *   値は「％」で持つ。JSへは割合（0.1 など）に直して渡す。
 */

if (!defined('ABSPATH')) exit;

/** key => array(表示名, 掛ける相手, 下限%, 上限%, 使うツール) */
function skt_rate_spec() {
    return array(
        'jinushi'   => array('地主に売るときの価格',              '借地権価格', 50, 70, '売却相場'),
        'third'     => array('第三者に売るときの価格',            '借地権価格', 60, 80, '売却相場'),
        'doji'      => array('底地と一緒に売るときの取り分',      '更地価格×借地権割合', 90, 100, '売却相場'),
        'jouto'     => array('譲渡承諾料（名義書換料）',          '借地権価格', 10, 10, '売却相場・承諾料'),
        'k_sarachi' => array('更新料（更地価格から見る場合）',    '更地価格', 3, 5, '更新料'),
        'k_shakuchi'=> array('更新料（借地権価格から見る場合）',  '借地権価格', 5, 10, '更新料'),
        'tatekae'   => array('建て替えの承諾料',                  '更地価格', 3, 5, '承諾料'),
        'zoukai'    => array('増改築（リフォーム）の承諾料',      '更地価格', 2, 3, '承諾料'),
        'jouken'    => array('借地条件の変更承諾料（木造→鉄骨・RC）', '更地価格', 10, 10, '承諾料'),
    );
}

function skt_rate_defaults() {
    $d = array();
    foreach (skt_rate_spec() as $k => $s) $d[$k] = array('lo' => $s[2], 'hi' => $s[3]);
    return $d;
}

function skt_sanitize_rates($in) {
    $d = skt_rate_defaults();
    $out = array();
    foreach ($d as $k => $def) {
        $lo = isset($in[$k]['lo']) ? (float) str_replace(',', '.', (string) $in[$k]['lo']) : $def['lo'];
        $hi = isset($in[$k]['hi']) ? (float) str_replace(',', '.', (string) $in[$k]['hi']) : $def['hi'];
        $lo = max(0, min(200, $lo));
        $hi = max(0, min(200, $hi));
        if ($hi < $lo) { $t = $lo; $lo = $hi; $hi = $t; }
        $out[$k] = array('lo' => $lo, 'hi' => $hi);
    }
    return $out;
}

/** JSへ渡す形（割合） */
function skt_rates_for_js($rates) {
    $rates = skt_sanitize_rates($rates);
    $out = array();
    foreach ($rates as $k => $r) $out[$k] = array($r['lo'] / 100, $r['hi'] / 100);
    return $out;
}

function skt_rates_table($rates) {
    $rates = skt_sanitize_rates($rates);
    $def = skt_rate_defaults();
    ?>
    <table class="widefat striped" style="max-width:920px">
      <thead><tr><th>項目</th><th>掛ける相手</th><th style="width:110px">下限（%）</th><th style="width:110px">上限（%）</th><th>使うツール</th><th>既定</th></tr></thead>
      <tbody>
      <?php foreach (skt_rate_spec() as $k => $s) : ?>
        <tr>
          <td><strong><?php echo esc_html($s[0]); ?></strong></td>
          <td><?php echo esc_html($s[1]); ?></td>
          <td><input type="number" step="0.1" min="0" max="200" style="width:90px" name="<?php echo SKT_OPT; ?>[rates][<?php echo esc_attr($k); ?>][lo]" value="<?php echo esc_attr($rates[$k]['lo']); ?>"></td>
          <td><input type="number" step="0.1" min="0" max="200" style="width:90px" name="<?php echo SKT_OPT; ?>[rates][<?php echo esc_attr($k); ?>][hi]" value="<?php echo esc_attr($rates[$k]['hi']); ?>"></td>
          <td><?php echo esc_html($s[4]); ?></td>
          <td style="color:#888"><?php echo esc_html($def[$k]['lo'] . '〜' . $def[$k]['hi'] . '%'); ?></td>
        </tr>
      <?php endforeach; ?>
      </tbody>
    </table>
    <?php
}
