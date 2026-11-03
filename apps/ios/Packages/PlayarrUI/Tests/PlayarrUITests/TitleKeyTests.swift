import Testing
@testable import PlayarrUI

@Suite struct TitleKeyTests {
  @Test func foldsEditionsAccentsAndPunctuation() {
    #expect(TitleKey.of("Mezzanine (Deluxe Edition)") == "mezzanine")
    #expect(TitleKey.of("Mezzanine [2018 Remaster]") == "mezzanine")
    #expect(TitleKey.of("Blue Lines - 2012 Mix/Master") == "blue lines")
    #expect(TitleKey.of("Café Tacvba") == "cafe tacvba")
    #expect(TitleKey.of("100th Window") == "100th window")
  }

  @Test func keepsATitleThatIsAllPunctuation() {
    #expect(TitleKey.of(" !!! ") == "!!!")
  }
}
