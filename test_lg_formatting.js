const fs = require('fs');
const { parseEarthquake } = require('./lib/parsers/earthquake');
const { formatEarthquake } = require('./lib/formatter');

const testXml = `
<Report xmlns="http://xml.kishou.go.jp/jmaxml1/">
  <Control>
    <Title>震源・震度に関する情報</Title>
    <Status>通常</Status>
  </Control>
  <Head xmlns="http://xml.kishou.go.jp/jmaxml1/informationBasis1/">
    <Title>地震情報</Title>
    <ReportDateTime>2026-03-21T14:18:00+09:00</ReportDateTime>
    <TargetDateTime>2026-03-21T14:18:00+09:00</TargetDateTime>
    <EventID>20260321141800</EventID>
    <InfoKind>地震情報</InfoKind>
  </Head>
  <Body xmlns="http://xml.kishou.go.jp/jmaxml1/body/seismology1/">
    <Earthquake>
      <OriginTime>2026-03-21T10:18:00+09:00</OriginTime>
      <Hypocenter>
        <Area>
          <Name>テスト震源</Name>
          <Code>999</Code>
        </Area>
      </Hypocenter>
      <jmx_eb:Magnitude xmlns:jmx_eb="http://xml.kishou.go.jp/jmaxml1/elementBasis1/" description="Ｍ６．０">6.0</jmx_eb:Magnitude>
    </Earthquake>
    <LgIntensity>
      <Observation>
        <MaxLgInt>4</MaxLgInt>
        <Pref>
          <Name>テスト県</Name>
          <Area>
            <Name>○○市</Name>
            <MaxLgInt>4</MaxLgInt>
          </Area>
        </Pref>
      </Observation>
    </LgIntensity>
  </Body>
</Report>
`;

try {
    const parsed = parseEarthquake(testXml);
    const formatted = formatEarthquake(parsed);
    const output = formatted.lines.join('\n');
    fs.writeFileSync('d:/kishou_server/test_lg_output.txt', output);
    console.log('Output saved to d:/kishou_server/test_lg_output.txt');
} catch (e) {
    console.error('Test Error:', e);
}
