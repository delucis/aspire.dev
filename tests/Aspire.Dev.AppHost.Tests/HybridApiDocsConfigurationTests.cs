namespace Aspire.Dev.AppHost.Tests;

public sealed class HybridApiDocsConfigurationTests
{
    [Theory]
    [InlineData(null, false)]
    [InlineData("0", false)]
    [InlineData("1", true)]
    public void BuildModeRequiresExplicitOptIn(string? value, bool expected)
        => Assert.Equal(expected, HybridApiDocsExtensions.IsHybridApiDocsEnabled(value));

    [Fact]
    public void InvalidBuildModeFailsClearly()
        => Assert.Throws<InvalidOperationException>(() => HybridApiDocsExtensions.IsHybridApiDocsEnabled("true"));
}
