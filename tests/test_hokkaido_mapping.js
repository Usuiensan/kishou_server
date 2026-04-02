const fs = require('fs');
const path = require('path');
const { parseEarthquake } = require('../lib/parsers/earthquake');
const { formatEarthquake } = require('../lib/formatter');

const mockXml = `
<Report xmlns="http://xml.kishou.go.jp/jmaxml1/">
  <Control><Title>緊急地震速報（警報）</Title><DateTime>2024-04-17T14:15:58Z</DateTime><Status>通常</Status></Control>
  <Head xmlns="http://xml.kishou.go.jp/jmaxml1/informationBasis1/">
    <Title>緊急地震速報（警報）</Title>
    <EventID>20240417231454</EventID>
    <InfoType>発表</InfoType>
    <InfoKind>緊急地震速報</InfoKind>
    <Headline>
      <Text>北海道で地震</Text>
      <Information type="緊急地震速報（府県予報区）">
        <Item>
          <Areas codeType="緊急地震速報／府県予報区">
            <Area><Name>石狩</Name></Area>
            <Area><Name>空知</Name></Area>
            <Area><Name>上川</Name></Area>
            <Area><Name>渡島</Name></Area>
            <Area><Name>網走・北見・紋別</Name></Area>
          </Areas>
        </Item>
      </Information>
    </Headline>
  </Head>
  <Body xmlns="http://xml.kishou.go.jp/jmaxml1/body/seismology1/">
    <Earthquake><Hypocenter><Area><Name>北海道沖</Name></Area></Hypocenter></Earthquake>
    <Comments><WarningComment><Text>強い揺れに警戒</Text></WarningComment></Comments>
  </Body>
</Report>
`;

const parsed = parseEarthquake(mockXml);
const formatted = formatEarthquake(parsed);
console.log(JSON.stringify(formatted, null, 2));
